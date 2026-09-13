import type pg from "pg";
import type { AdminSeedBody, CreateWalletReply, WalletReply, WalletRow } from "../domain/types.js";
import { toSafeNumber } from "../domain/validation.js";

function createWalletReply(wallet: WalletRow): CreateWalletReply {
  return {
    wallet_id: wallet.id,
    user_id: wallet.user_id,
    balance_paise: toSafeNumber(wallet.balance_paise)
  };
}

export async function getOrCreateWallet(pool: pg.Pool, userId: string): Promise<CreateWalletReply> {
  const result = await pool.query<WalletRow>(
    `
      insert into wallets (user_id)
      values ($1)
      on conflict (user_id) do update
        set updated_at = wallets.updated_at
      returning id, user_id, balance_paise
    `,
    [userId]
  );

  return createWalletReply(result.rows[0]);
}

export async function getWallet(pool: pg.Pool, walletId: string): Promise<WalletReply | null> {
  const result = await pool.query<WalletRow>("select id, user_id, balance_paise from wallets where id = $1", [walletId]);
  const wallet = result.rows[0];

  if (!wallet) {
    return null;
  }

  return {
    wallet_id: wallet.id,
    balance_paise: toSafeNumber(wallet.balance_paise)
  };
}

export async function seedWallet(pool: pg.Pool, body: AdminSeedBody): Promise<CreateWalletReply> {
  const result = await pool.query<WalletRow>(
    `
      insert into wallets (user_id, balance_paise)
      values ($1, $2)
      on conflict (user_id) do update
        set balance_paise = excluded.balance_paise,
            updated_at = now()
      returning id, user_id, balance_paise
    `,
    [body.user_id, body.balance_paise]
  );

  return createWalletReply(result.rows[0]);
}
