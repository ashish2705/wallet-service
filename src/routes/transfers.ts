import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { CreateTransferBody, TransferReply } from "../domain/types.js";
import { isPositiveInteger, isUuid } from "../domain/validation.js";
import {
  idempotentReplaysTotal,
  transfersCreatedTotal,
  transfersDeclinedInsufficientFundsTotal
} from "../metrics.js";
import { createTransfer, getTransfer } from "../services/transfers.js";

function isValidTransferBody(body: CreateTransferBody | undefined): body is CreateTransferBody {
  return Boolean(
    body &&
      isUuid(body.from) &&
      isUuid(body.to) &&
      body.from !== body.to &&
      typeof body.idempotency_key === "string" &&
      body.idempotency_key.length > 0 &&
      isPositiveInteger(body.amount_paise)
  );
}

export function registerTransferRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post<{ Body: CreateTransferBody }>("/transfers", async (request, reply): Promise<TransferReply> => {
    const body = request.body;
    if (!isValidTransferBody(body)) {
      return reply.code(400).send({ error: "invalid_transfer_request" }) as never;
    }

    const result = await createTransfer(pool, body, request.log);

    if (result.type === "conflict") {
      request.log.warn(
        { event: "transfer.idempotency_conflict", idempotency_key: body.idempotency_key },
        "idempotency key replayed with different body"
      );
      return reply.code(409).send({ error: "idempotency_key_conflict" }) as never;
    }

    if (result.type === "wallet_not_found") {
      return reply.code(404).send({ error: "wallet_not_found" }) as never;
    }

    if (result.type === "replay") {
      idempotentReplaysTotal.inc();
      request.log.info(
        {
          event: "transfer.idempotent_replay_hit",
          transfer_id: result.transfer.transfer_id,
          idempotency_key: body.idempotency_key
        },
        "idempotent transfer replay returned"
      );
      return result.transfer;
    }

    transfersCreatedTotal.inc();
    request.log.info(
      {
        event: "transfer.created",
        transfer_id: result.transfer.transfer_id,
        from: body.from,
        to: body.to,
        amount_paise: body.amount_paise,
        idempotency_key: body.idempotency_key,
        status: result.transfer.status
      },
      "transfer created"
    );

    if (result.transfer.status === "declined_insufficient_funds") {
      transfersDeclinedInsufficientFundsTotal.inc();
      request.log.info(
        {
          event: "transfer.declined",
          reason: "insufficient_funds",
          transfer_id: result.transfer.transfer_id,
          from: body.from,
          to: body.to,
          amount_paise: body.amount_paise,
          idempotency_key: body.idempotency_key
        },
        "transfer declined"
      );
    }

    return result.transfer;
  });

  app.get<{ Params: { id: string } }>("/transfers/:id", async (request, reply): Promise<TransferReply> => {
    const transferId = request.params.id;

    if (!isUuid(transferId)) {
      return reply.code(400).send({ error: "invalid_transfer_id" }) as never;
    }

    const transfer = await getTransfer(pool, transferId);
    if (!transfer) {
      return reply.code(404).send({ error: "transfer_not_found" }) as never;
    }

    request.log.info({ event: "transfer.status_read", transfer_id: transferId }, "transfer status returned");
    return transfer;
  });
}
