from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DepositorPosition, Draw, Epoch, IndexerCursor, PoolSnapshot


def _apply(obj, **fields) -> None:
    for k, v in fields.items():
        if v is not None:
            setattr(obj, k, v)


class StateRepo:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def upsert_position(
        self, *, address, principal, join_epoch=None, eligible=None
    ) -> DepositorPosition:
        pos = await self.db.get(DepositorPosition, address)
        if pos is None:
            pos = DepositorPosition(
                address=address, principal=principal, join_epoch=join_epoch, eligible=bool(eligible)
            )
            self.db.add(pos)
        else:
            pos.principal = principal
            _apply(pos, join_epoch=join_epoch, eligible=eligible)
        return pos

    async def bump_principal(self, *, address, delta, join_epoch=None) -> DepositorPosition:
        pos = await self.db.get(DepositorPosition, address)
        if pos is None:
            pos = DepositorPosition(
                address=address, principal=max(delta, 0), join_epoch=join_epoch, eligible=False
            )
            self.db.add(pos)
        else:
            pos.principal = pos.principal + delta
            if join_epoch is not None and pos.join_epoch is None:
                pos.join_epoch = join_epoch
        return pos

    async def get_position(self, address) -> DepositorPosition | None:
        return await self.db.get(DepositorPosition, address)

    async def list_positions(
        self, *, eligible_only: bool = False, limit: int | None = None
    ) -> list[DepositorPosition]:
        q = select(DepositorPosition).order_by(DepositorPosition.principal.desc())
        if eligible_only:
            q = q.where(DepositorPosition.eligible.is_(True))
        if limit:
            q = q.limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def total_principal(self) -> int:
        q = select(func.coalesce(func.sum(DepositorPosition.principal), 0))
        return (await self.db.execute(q)).scalar_one()

    async def eligible_total(self) -> int:
        q = select(func.coalesce(func.sum(DepositorPosition.principal), 0)).where(
            DepositorPosition.eligible.is_(True)
        )
        return (await self.db.execute(q)).scalar_one()

    async def list_draws(self, limit: int = 50) -> list[Draw]:
        q = select(Draw).order_by(Draw.epoch.desc()).limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def get_draw(self, epoch: int) -> Draw | None:
        return await self.db.get(Draw, epoch)

    async def upsert_epoch(
        self,
        *,
        epoch,
        started_at=None,
        deposit_deadline=None,
        harvested_yield=None,
        prize_pot=None,
        settled=None,
    ) -> Epoch:
        row = await self.db.get(Epoch, epoch)
        if row is None:
            row = Epoch(epoch=epoch)
            self.db.add(row)
        _apply(
            row,
            started_at=started_at,
            deposit_deadline=deposit_deadline,
            harvested_yield=harvested_yield,
            prize_pot=prize_pot,
            settled=settled,
        )
        return row

    async def upsert_draw(
        self,
        *,
        epoch,
        seed=None,
        distributable=None,
        skim=None,
        num_winners=None,
        settled_ts=None,
        settle_tx=None,
    ) -> Draw:
        row = await self.db.get(Draw, epoch)
        if row is None:
            row = Draw(epoch=epoch)
            self.db.add(row)
        _apply(
            row,
            seed=seed,
            distributable=distributable,
            skim=skim,
            num_winners=num_winners,
            settled_ts=settled_ts,
            settle_tx=settle_tx,
        )
        return row

    async def add_snapshot(self, **fields) -> PoolSnapshot:
        snap = PoolSnapshot(**fields)
        self.db.add(snap)
        return snap

    async def latest_snapshot(self) -> PoolSnapshot | None:
        q = select(PoolSnapshot).order_by(PoolSnapshot.id.desc()).limit(1)
        return (await self.db.execute(q)).scalar_one_or_none()

    async def list_snapshots(self, limit: int = 50) -> list[PoolSnapshot]:
        q = select(PoolSnapshot).order_by(PoolSnapshot.id.desc()).limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def list_epochs(self, limit: int = 50) -> list[Epoch]:
        q = select(Epoch).order_by(Epoch.epoch.desc()).limit(limit)
        return list((await self.db.execute(q)).scalars())

    async def get_epoch(self, epoch: int) -> Epoch | None:
        return await self.db.get(Epoch, epoch)

    async def get_cursor(self, account) -> IndexerCursor | None:
        return await self.db.get(IndexerCursor, account)

    async def upsert_cursor(self, *, account, last_lt, last_hash=None) -> IndexerCursor:
        cur = await self.db.get(IndexerCursor, account)
        if cur is None:
            cur = IndexerCursor(account=account, last_lt=last_lt, last_hash=last_hash)
            self.db.add(cur)
        else:
            cur.last_lt = last_lt
            _apply(cur, last_hash=last_hash)
        return cur
