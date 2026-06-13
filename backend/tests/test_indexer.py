from sqlalchemy import func, select

from app.indexer import Indexer
from app.models import Deposit, Harvest, Withdrawal
from tests._chain import A1, FakeChainClient, deposit_body, harvest_body, tx, withdraw_body

POOL = "0:" + "aa" * 32
ADAPTER = "0:" + "bb" * 32


async def _count(db, model) -> int:
    return (await db.execute(select(func.count()).select_from(model))).scalar_one()


def _pool_txs():
    return [
        tx("d1", 10, 100, deposit_body(1000, A1), src=POOL),
        tx("d2", 20, 110, deposit_body(2000, A1), src=POOL),
        tx("w1", 30, 200, withdraw_body(500), src=A1),
    ]


async def test_scan_writes_events_and_advances_cursor(db):
    fake = FakeChainClient({POOL: _pool_txs()})
    ix = Indexer(fake, db)
    res = await ix.scan_account(POOL)
    await db.commit()

    assert (res.scanned, res.deposits, res.withdrawals) == (3, 2, 1)
    assert await _count(db, Deposit) == 2
    assert await _count(db, Withdrawal) == 1
    cur = await ix.state.get_cursor(POOL)
    assert cur.last_lt == 30 and cur.last_hash == "w1"


async def test_replay_is_idempotent(db):
    fake = FakeChainClient({POOL: _pool_txs()})
    ix = Indexer(fake, db)
    await ix.scan_account(POOL)
    await db.commit()

    await ix.state.upsert_cursor(account=POOL, last_lt=0)  # rewind; events dedupe by tx hash
    await db.commit()
    res2 = await ix.scan_account(POOL)
    await db.commit()

    assert res2.scanned == 3 and res2.deposits == 0 and res2.withdrawals == 0
    assert await _count(db, Deposit) == 2
    assert await _count(db, Withdrawal) == 1


async def test_harvest_event_nets_fee(db):
    fake = FakeChainClient({ADAPTER: [tx("h1", 5, 50, harvest_body(2000, 2500))]})
    ix = Indexer(fake, db, fee_bps=100)
    res = await ix.scan_account(ADAPTER)
    await db.commit()

    assert res.harvests == 1
    h = (await db.execute(select(Harvest))).scalar_one()
    assert (h.gross_yield, h.lp_burned, h.net_yield) == (2500, 2000, 2475)
