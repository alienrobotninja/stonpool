from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Deposit, Harvest, Payout, Withdrawal

# repos never commit. the caller owns the unit of work (session_scope / get_db).
# idempotency relies on autoflush: the existence check flushes same-session pending
# rows, so a tx repeated inside one batch is caught before the unique constraint fires.


class EventRepo:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def _seen(self, model, **keys) -> bool:
        q = select(model.id).filter_by(**keys).limit(1)
        return (await self.db.execute(q)).first() is not None

    async def add_deposit(self, *, tx_hash, lt, ts, depositor, amount, epoch=None) -> bool:
        if await self._seen(Deposit, tx_hash=tx_hash):
            return False
        self.db.add(
            Deposit(tx_hash=tx_hash, lt=lt, ts=ts, epoch=epoch, depositor=depositor, amount=amount)
        )
        return True

    async def add_withdrawal(self, *, tx_hash, lt, ts, depositor, amount, epoch=None) -> bool:
        if await self._seen(Withdrawal, tx_hash=tx_hash):
            return False
        self.db.add(
            Withdrawal(
                tx_hash=tx_hash, lt=lt, ts=ts, epoch=epoch, depositor=depositor, amount=amount
            )
        )
        return True

    async def add_harvest(
        self, *, tx_hash, lt, ts, gross_yield, net_yield, lp_burned, epoch=None
    ) -> bool:
        if await self._seen(Harvest, tx_hash=tx_hash):
            return False
        self.db.add(
            Harvest(
                tx_hash=tx_hash,
                lt=lt,
                ts=ts,
                epoch=epoch,
                gross_yield=gross_yield,
                net_yield=net_yield,
                lp_burned=lp_burned,
            )
        )
        return True

    async def add_payout(self, *, tx_hash, lt, ts, winner, amount, tier, epoch=None) -> bool:
        if await self._seen(Payout, tx_hash=tx_hash, winner=winner):
            return False
        self.db.add(
            Payout(
                tx_hash=tx_hash, lt=lt, ts=ts, epoch=epoch, winner=winner, amount=amount, tier=tier
            )
        )
        return True

    async def recent_deposits(self, limit: int = 50) -> list[Deposit]:
        q = select(Deposit).order_by(Deposit.lt.desc()).limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def recent_withdrawals(self, limit: int = 50) -> list[Withdrawal]:
        q = select(Withdrawal).order_by(Withdrawal.lt.desc()).limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def recent_harvests(self, limit: int = 50) -> list[Harvest]:
        q = select(Harvest).order_by(Harvest.lt.desc()).limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def recent_payouts(self, limit: int = 50) -> list[Payout]:
        q = select(Payout).order_by(Payout.lt.desc()).limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def payouts_for_epoch(self, epoch: int) -> list[Payout]:
        q = select(Payout).where(Payout.epoch == epoch).order_by(Payout.tier)
        return list((await self.db.execute(q)).scalars())
