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
