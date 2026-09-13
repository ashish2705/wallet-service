export type CreateWalletReply = {
  wallet_id: string;
  user_id: string;
  balance_paise: number;
};

export type WalletReply = {
  wallet_id: string;
  balance_paise: number;
};

export type CreateTransferBody = {
  from: string;
  to: string;
  amount_paise: number;
  idempotency_key: string;
};

export type TransferStatus = "succeeded" | "declined_insufficient_funds" | "pending";

export type TransferReply = {
  transfer_id: string;
  from: string;
  to: string;
  amount_paise: number;
  idempotency_key: string;
  status: TransferStatus;
};

export type AdminSeedBody = {
  user_id: string;
  balance_paise: number;
};

export type WalletRow = {
  id: string;
  user_id: string;
  balance_paise: string;
};

export type TransferRow = {
  id: string;
  idempotency_key: string;
  request_hash: string;
  from_wallet_id: string;
  to_wallet_id: string;
  amount_paise: string;
  status: TransferStatus;
};
