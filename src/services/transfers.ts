import crypto from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { CreateTransferBody, TransferReply, TransferRow, TransferStatus, WalletRow } from "../domain/types.js";
import { toSafeNumber } from "../domain/validation.js";

export type CreateTransferResult =
  | { type: "created"; transfer: TransferReply }
  | { type: "replay"; transfer: TransferReply }
  | { type: "conflict" }
  | { type: "wallet_not_found" };

function transferRequestHash(body: CreateTransferBody): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ from: body.from, to: body.to, amount_paise: body.amount_paise }))
    .digest("hex");
}

function transferReply(row: TransferRow): TransferReply {
  return {
    transfer_id: row.id,
    from: row.from_wallet_id,
    to: row.to_wallet_id,
    amount_paise: toSafeNumber(row.amount_paise),
    idempotency_key: row.idempotency_key,
    status: row.status
  };
}

async function rollback(client: pg.PoolClient): Promise<void> {
  await client.query("rollback").catch(() => undefined);
}

export async function createTransfer(
  pool: pg.Pool,
  body: CreateTransferBody,
  log: FastifyBaseLogger
): Promise<CreateTransferResult> {
  const requestHash = transferRequestHash(body);
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [body.idempotency_key]);

    const existing = await client.query<TransferRow>(
      `
        select id, idempotency_key, request_hash, from_wallet_id, to_wallet_id, amount_paise, status
        from transfers
        where idempotency_key = $1
      `,
      [body.idempotency_key]
    );

    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        await rollback(client);
        return { type: "conflict" };
      }

      await client.query("commit");
      return { type: "replay", transfer: transferReply(existing.rows[0]) };
    }

    const wallets = await client.query<WalletRow>(
      `
        select id, user_id, balance_paise
        from wallets
        where id = any($1::uuid[])
        order by id
        for update
      `,
      [[body.from, body.to]]
    );

    if (wallets.rows.length !== 2) {
      await rollback(client);
      return { type: "wallet_not_found" };
    }

    const fromWallet = wallets.rows.find((wallet) => wallet.id === body.from);
    const toWallet = wallets.rows.find((wallet) => wallet.id === body.to);

    if (!fromWallet || !toWallet) {
      await rollback(client);
      return { type: "wallet_not_found" };
    }

    const fromBalance = toSafeNumber(fromWallet.balance_paise);
    const status: TransferStatus =
      fromBalance >= body.amount_paise ? "succeeded" : "declined_insufficient_funds";

    if (status === "succeeded") {
      await client.query("update wallets set balance_paise = balance_paise - $1, updated_at = now() where id = $2", [
        body.amount_paise,
        body.from
      ]);
      log.info({ event: "transfer.debited", from: body.from, amount_paise: body.amount_paise }, "wallet debited");

      await client.query("update wallets set balance_paise = balance_paise + $1, updated_at = now() where id = $2", [
        body.amount_paise,
        body.to
      ]);
      log.info({ event: "transfer.credited", to: body.to, amount_paise: body.amount_paise }, "wallet credited");
    }

    const created = await client.query<TransferRow>(
      `
        insert into transfers (
          idempotency_key,
          request_hash,
          from_wallet_id,
          to_wallet_id,
          amount_paise,
          status
        )
        values ($1, $2, $3, $4, $5, $6)
        returning id, idempotency_key, request_hash, from_wallet_id, to_wallet_id, amount_paise, status
      `,
      [body.idempotency_key, requestHash, body.from, body.to, body.amount_paise, status]
    );

    await client.query("commit");
    return { type: "created", transfer: transferReply(created.rows[0]) };
  } catch (error) {
    await rollback(client);
    log.error({ err: error, event: "transfer.failed" }, "transfer failed");
    throw error;
  } finally {
    client.release();
  }
}

export async function getTransfer(pool: pg.Pool, transferId: string): Promise<TransferReply | null> {
  const result = await pool.query<TransferRow>(
    `
      select id, idempotency_key, request_hash, from_wallet_id, to_wallet_id, amount_paise, status
      from transfers
      where id = $1
    `,
    [transferId]
  );
  const transfer = result.rows[0];

  return transfer ? transferReply(transfer) : null;
}
