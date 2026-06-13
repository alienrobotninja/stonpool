from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients.chain import ChainClient
from app.clients.quote import lp_value
from app.clients.sources import (
    QuoteSource,
    read_adapter_state,
    read_balance_of,
    read_pool_data,
)
from app.core.config import Settings, get_settings
from app.models import Deposit, PoolSnapshot
from app.repositories import StateRepo


@dataclass(frozen=True)
class DriftReport:
    pool_total: int
    adapter_principal: int
    positions_total: int

    @property
    def ok(self) -> bool:
        return self.pool_total == self.adapter_principal == self.positions_total


class DerivedService:
    # builds the derived view the api reads from: point-in-time snapshots, per-depositor
    # positions reconciled against the authoritative on-chain ledger, and a drift check
    # that flags any divergence between pool-core, the adapter, and the position table.
    def __init__(
        self,
        client: ChainClient,
        quote_source: QuoteSource,
        db: AsyncSession,
        cfg: Settings | None = None,
    ):
        self.client = client
        self.quote_source = quote_source
        self.db = db
        self.state = StateRepo(db)
        self.cfg = cfg or get_settings()

    async def capture_snapshot(self) -> PoolSnapshot:
        pd = await read_pool_data(self.client, self.cfg.pool_core_address)
        adp = await read_adapter_state(self.client, self.cfg.adapter_address)
        q = await self.quote_source.fetch()
        accrued = max(lp_value(adp.lp_balance, q) - adp.principal, 0)
        snap = await self.state.add_snapshot(
            epoch=pd.epoch,
            deposit_deadline=pd.deposit_deadline,
            total_principal=pd.total_principal,
            prize_pot=pd.prize_pot,
            adapter_principal=adp.principal,
            adapter_lp_balance=adp.lp_balance,
            stonfi_reserve=q.reserve,
            stonfi_lp_supply=q.lp_supply,
            accrued_yield=accrued,
        )
        await self.state.upsert_epoch(
            epoch=pd.epoch, deposit_deadline=pd.deposit_deadline, prize_pot=pd.prize_pot
        )
        return snap

    async def reconcile_positions(self) -> int:
        pd = await read_pool_data(self.client, self.cfg.pool_core_address)
        n = 0
        for addr in await self._depositors():
            weight, join_epoch = await read_balance_of(
                self.client, self.cfg.pool_core_address, addr
            )
            eligible = weight > 0 and (pd.epoch - join_epoch) >= self.cfg.min_hold_epochs
            await self.state.upsert_position(
                address=addr, principal=weight, join_epoch=join_epoch, eligible=eligible
            )
            n += 1
        return n

    async def check_drift(self) -> DriftReport:
        pd = await read_pool_data(self.client, self.cfg.pool_core_address)
        adp = await read_adapter_state(self.client, self.cfg.adapter_address)
        return DriftReport(
            pool_total=pd.total_principal,
            adapter_principal=adp.principal,
            positions_total=await self.state.total_principal(),
        )

    async def refresh(self) -> DriftReport:
        await self.reconcile_positions()
        await self.capture_snapshot()
        return await self.check_drift()

    async def _depositors(self) -> list[str]:
        q = select(Deposit.depositor).distinct()
        return list((await self.db.execute(q)).scalars())
