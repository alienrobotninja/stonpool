// mirrors the backend Pydantic response models. amounts are int64 on the wire; numbers are
// fine at demo scale (jetton units stay well under 2^53). revisit with bigint if amounts grow.

export interface Health {
  status: string;
  env: string;
}

export interface Snapshot {
  epoch: number;
  deposit_deadline: number;
  total_principal: number;
  prize_pot: number;
  adapter_principal: number;
  adapter_lp_balance: number;
  stonfi_reserve: number;
  stonfi_lp_supply: number;
  accrued_yield: number;
  created_at: string;
}

export interface Epoch {
  epoch: number;
  started_at: number | null;
  deposit_deadline: number | null;
  harvested_yield: number;
  prize_pot: number;
  settled: boolean;
  updated_at: string;
}

export interface Position {
  address: string;
  principal: number;
  join_epoch: number | null;
  eligible: boolean;
  odds: number;
}

export type EventKind = "deposit" | "withdrawal" | "harvest" | "payout";

export interface ActivityEvent {
  kind: EventKind;
  tx_hash: string;
  lt: number;
  ts: number;
  epoch: number | null;
  address: string | null;
  amount: number | null;
  gross_yield: number | null;
  net_yield: number | null;
  lp_burned: number | null;
  tier: number | null;
}

export interface Payout {
  winner: string;
  amount: number;
  tier: number;
  tx_hash: string;
  ts: number;
}

export interface Draw {
  epoch: number;
  seed: string | null;
  distributable: number;
  skim: number;
  num_winners: number;
  settled_ts: number | null;
  payouts: Payout[];
}

export interface WalletBalance {
  owner: string;
  jetton_wallet: string;
  balance: number;
}