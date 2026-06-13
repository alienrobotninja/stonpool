from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import Address, Amount, TxHash


class _Event(Base):
    __abstract__ = True

    id: Mapped[int] = mapped_column(primary_key=True)
    tx_hash: Mapped[str] = mapped_column(TxHash, index=True)
    lt: Mapped[int] = mapped_column(BigInteger)
    ts: Mapped[int] = mapped_column(BigInteger)  # on-chain unix time
    epoch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Deposit(_Event):
    __tablename__ = "deposits"
    __table_args__ = (UniqueConstraint("tx_hash"),)

    depositor: Mapped[str] = mapped_column(Address, index=True)
    amount: Mapped[int] = mapped_column(Amount)


class Withdrawal(_Event):
    __tablename__ = "withdrawals"
    __table_args__ = (UniqueConstraint("tx_hash"),)

    depositor: Mapped[str] = mapped_column(Address, index=True)
    amount: Mapped[int] = mapped_column(Amount)


class Harvest(_Event):
    __tablename__ = "harvests"
    __table_args__ = (UniqueConstraint("tx_hash"),)

    gross_yield: Mapped[int] = mapped_column(Amount)
    net_yield: Mapped[int] = mapped_column(Amount)
    lp_burned: Mapped[int] = mapped_column(Amount)


class Payout(_Event):
    __tablename__ = "payouts"
    # a single settle can pay several winners; one row per (tx, winner)
    __table_args__ = (UniqueConstraint("tx_hash", "winner"),)

    winner: Mapped[str] = mapped_column(Address, index=True)
    amount: Mapped[int] = mapped_column(Amount)
    tier: Mapped[int] = mapped_column(Integer)
