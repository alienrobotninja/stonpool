from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.clients.chain import ChainClient
from app.clients.quote import net_of_fee
from app.indexer.decode import DepositEvent, HarvestEvent, WithdrawEvent, decode_in_message
from app.repositories import EventRepo, StateRepo


@dataclass
class IndexResult:
    scanned: int = 0
    deposits: int = 0
    withdrawals: int = 0
    harvests: int = 0


def _in_msg(tx: dict) -> dict:
    return tx.get("in_msg") or {}


def _body(tx: dict) -> str | None:
    return (_in_msg(tx).get("message_content") or {}).get("body")


def _src(tx: dict) -> str | None:
    return _in_msg(tx).get("source")


def _lt(tx: dict) -> int:
    return int(tx.get("lt", 0))


class Indexer:
    # repos never commit; the runner wraps a scan in session_scope so each pass is one
    # unit of work. cursor advances by max lt seen, so replay re-fetches nothing; even if
    # a source re-serves the same txs, the event repos drop duplicates by tx hash.
    def __init__(self, client: ChainClient, db: AsyncSession, *, fee_bps: int = 0):
        self.client = client
        self.events = EventRepo(db)
        self.state = StateRepo(db)
        self.fee_bps = fee_bps

    async def scan_account(self, account: str, *, limit: int = 50) -> IndexResult:
        cur = await self.state.get_cursor(account)
        after = cur.last_lt if cur else 0
        txs = await self.client.get_transactions(account, after_lt=after, limit=limit)
        res = IndexResult()
        max_lt = after
        max_hash = cur.last_hash if cur else None
        for tx in txs:
            res.scanned += 1
            await self._apply(decode_in_message(_body(tx), _src(tx)), tx, res)
            if _lt(tx) > max_lt:
                max_lt, max_hash = _lt(tx), tx.get("hash")
        if res.scanned:
            await self.state.upsert_cursor(account=account, last_lt=max_lt, last_hash=max_hash)
        return res

    async def _apply(self, ev, tx: dict, res: IndexResult) -> None:
        if ev is None:
            return
        meta = {"tx_hash": tx.get("hash"), "lt": _lt(tx), "ts": int(tx.get("now", 0))}
        if isinstance(ev, DepositEvent):
            if await self.events.add_deposit(depositor=ev.depositor, amount=ev.amount, **meta):
                res.deposits += 1
        elif isinstance(ev, WithdrawEvent):
            if await self.events.add_withdrawal(depositor=ev.depositor, amount=ev.amount, **meta):
                res.withdrawals += 1
        elif isinstance(ev, HarvestEvent):
            net = net_of_fee(ev.gross_yield, self.fee_bps)
            if await self.events.add_harvest(
                gross_yield=ev.gross_yield, net_yield=net, lp_burned=ev.lp_to_burn, **meta
            ):
                res.harvests += 1
