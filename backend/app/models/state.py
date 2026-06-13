from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import Address, Amount, Seed, TxHash


class PoolSnapshot(Base):
    __tablename__ = "pool_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    epoch: Mapped[int] = mapped_column(Integer)
    deposit_deadline: Mapped[int] = mapped_column(BigInteger)
    total_principal: Mapped[int] = mapped_column(Amount)
    prize_pot: Mapped[int] = mapped_column(Amount)
    adapter_principal: Mapped[int] = mapped_column(Amount)
    adapter_lp_balance: Mapped[int] = mapped_column(Amount)
    stonfi_reserve: Mapped[int] = mapped_column(Amount)
    stonfi_lp_supply: Mapped[int] = mapped_column(Amount)
    accrued_yield: Mapped[int] = mapped_column(Amount)  # lp_balance*reserve/lp_supply - principal
    masterchain_seqno: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Epoch(Base):
    __tablename__ = "epochs"

    epoch: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    started_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    deposit_deadline: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    harvested_yield: Mapped[int] = mapped_column(Amount, default=0)
    prize_pot: Mapped[int] = mapped_column(Amount, default=0)
    settled: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DepositorPosition(Base):
    __tablename__ = "depositor_positions"

    address: Mapped[str] = mapped_column(Address, primary_key=True)
    principal: Mapped[int] = mapped_column(Amount, default=0)
    join_epoch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    eligible: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Draw(Base):
    __tablename__ = "draws"

    epoch: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    seed: Mapped[str | None] = mapped_column(Seed, nullable=True)
    distributable: Mapped[int] = mapped_column(Amount, default=0)
    skim: Mapped[int] = mapped_column(Amount, default=0)
    num_winners: Mapped[int] = mapped_column(Integer, default=0)
    settled_ts: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    settle_tx: Mapped[str | None] = mapped_column(TxHash, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class IndexerCursor(Base):
    __tablename__ = "indexer_cursors"

    account: Mapped[str] = mapped_column(Address, primary_key=True)
    last_lt: Mapped[int] = mapped_column(BigInteger, default=0)
    last_hash: Mapped[str | None] = mapped_column(TxHash, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
