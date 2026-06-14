from datetime import datetime

from pydantic import BaseModel, ConfigDict


class HealthOut(BaseModel):
    status: str
    env: str


class SnapshotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    epoch: int
    deposit_deadline: int
    total_principal: int
    prize_pot: int
    adapter_principal: int
    adapter_lp_balance: int
    stonfi_reserve: int
    stonfi_lp_supply: int
    accrued_yield: int
    created_at: datetime


class EpochOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    epoch: int
    started_at: int | None
    deposit_deadline: int | None
    harvested_yield: int
    prize_pot: int
    settled: bool
    updated_at: datetime


class PositionOut(BaseModel):
    address: str
    principal: int
    join_epoch: int | None
    eligible: bool
    odds: float  # eligible weight share in [0, 1]


class EventOut(BaseModel):
    kind: str  # deposit | withdrawal | harvest | payout
    tx_hash: str
    lt: int
    ts: int
    epoch: int | None = None
    address: str | None = None  # depositor or winner
    amount: int | None = None
    gross_yield: int | None = None
    net_yield: int | None = None
    lp_burned: int | None = None
    tier: int | None = None


class PayoutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    winner: str
    amount: int
    tier: int
    tx_hash: str
    ts: int


class DrawOut(BaseModel):
    epoch: int
    seed: str | None
    distributable: int
    skim: int
    num_winners: int
    settled_ts: int | None
    payouts: list[PayoutOut] = []


class WalletBalanceOut(BaseModel):
    owner: str
    jetton_wallet: str
    balance: int