from sqlalchemy import func, select

from app.models import Deposit, Epoch, Payout
from app.repositories import EventRepo, StateRepo


async def _count(db, model) -> int:
    return (await db.execute(select(func.count()).select_from(model))).scalar_one()


async def test_add_deposit_is_idempotent(db):
    repo = EventRepo(db)
    assert (
        await repo.add_deposit(tx_hash="a" * 64, lt=1, ts=1, depositor="0:d", amount=1000) is True
    )
    # same tx again, even before commit, is caught via autoflush
    assert (
        await repo.add_deposit(tx_hash="a" * 64, lt=2, ts=2, depositor="0:d", amount=1000) is False
    )
    await db.commit()
    assert await _count(db, Deposit) == 1


async def test_payout_idempotent_per_winner(db):
    repo = EventRepo(db)
    assert await repo.add_payout(tx_hash="b" * 64, lt=1, ts=1, winner="0:w1", amount=750, tier=0)
    assert await repo.add_payout(tx_hash="b" * 64, lt=1, ts=1, winner="0:w2", amount=750, tier=1)
    assert (
        await repo.add_payout(tx_hash="b" * 64, lt=1, ts=1, winner="0:w1", amount=1, tier=0)
        is False
    )
    await db.commit()
    assert await _count(db, Payout) == 2


async def test_recent_deposits_ordered_by_lt_desc(db):
    repo = EventRepo(db)
    for i, lt in enumerate([10, 30, 20]):
        await repo.add_deposit(tx_hash=f"{i:064d}", lt=lt, ts=lt, depositor="0:d", amount=100)
    await db.commit()
    lts = [d.lt for d in await repo.recent_deposits()]
    assert lts == [30, 20, 10]


async def test_position_upsert_and_aggregation(db):
    repo = StateRepo(db)
    await repo.upsert_position(address="0:big", principal=9000, join_epoch=5, eligible=True)
    await repo.upsert_position(address="0:mid", principal=5000, join_epoch=5, eligible=True)
    await repo.upsert_position(address="0:small", principal=900, join_epoch=5, eligible=False)
    await db.commit()

    await repo.upsert_position(address="0:big", principal=8000)  # update keeps eligible/join_epoch
    await db.commit()
    big = await repo.get_position("0:big")
    assert big.principal == 8000 and big.eligible is True and big.join_epoch == 5

    ranked = [p.address for p in await repo.list_positions()]
    assert ranked == ["0:big", "0:mid", "0:small"]
    elig = [p.address for p in await repo.list_positions(eligible_only=True)]
    assert set(elig) == {"0:big", "0:mid"}
    assert await repo.total_principal() == 8000 + 5000 + 900


async def test_bump_principal(db):
    repo = StateRepo(db)
    await repo.bump_principal(address="0:d", delta=1000, join_epoch=5)
    await repo.bump_principal(address="0:d", delta=500)
    await repo.bump_principal(address="0:d", delta=-300)
    await db.commit()
    pos = await repo.get_position("0:d")
    assert pos.principal == 1200 and pos.join_epoch == 5


async def test_epoch_and_draw_upsert(db):
    repo = StateRepo(db)
    await repo.upsert_epoch(epoch=5, started_at=100, prize_pot=2500)
    await repo.upsert_epoch(epoch=5, settled=True)  # partial update keeps prize_pot
    await db.commit()
    e = await db.get(Epoch, 5)
    assert e.prize_pot == 2500 and e.settled is True and e.started_at == 100

    await repo.upsert_draw(
        epoch=5, seed="0x" + "f" * 64, distributable=2250, skim=250, num_winners=3
    )
    await db.commit()
    d = await repo.upsert_draw(epoch=5, settle_tx="d" * 64)
    assert d.distributable == 2250 and d.settle_tx == "d" * 64


async def test_snapshot_latest_and_cursor(db):
    repo = StateRepo(db)
    base = dict(
        deposit_deadline=1,
        total_principal=0,
        prize_pot=0,
        adapter_principal=0,
        adapter_lp_balance=0,
        stonfi_reserve=0,
        stonfi_lp_supply=0,
        accrued_yield=0,
    )
    await repo.add_snapshot(epoch=5, **base)
    await repo.add_snapshot(epoch=6, **base)
    await db.commit()
    assert (await repo.latest_snapshot()).epoch == 6

    await repo.upsert_cursor(account="0:pool", last_lt=10, last_hash="x" * 64)
    await repo.upsert_cursor(account="0:pool", last_lt=20)
    await db.commit()
    cur = await repo.get_cursor("0:pool")
    assert cur.last_lt == 20 and cur.last_hash == "x" * 64


async def test_state_read_methods(db):
    repo = StateRepo(db)
    base = dict(
        deposit_deadline=1,
        total_principal=0,
        prize_pot=0,
        adapter_principal=0,
        adapter_lp_balance=0,
        stonfi_reserve=0,
        stonfi_lp_supply=0,
        accrued_yield=0,
    )
    await repo.add_snapshot(epoch=5, **base)
    await repo.add_snapshot(epoch=6, **base)
    await repo.upsert_epoch(epoch=5, prize_pot=2500)
    await repo.upsert_epoch(epoch=6, prize_pot=0)
    await repo.upsert_position(address="0:a", principal=6000, eligible=True)
    await repo.upsert_position(address="0:b", principal=4000, eligible=True)
    await repo.upsert_position(address="0:c", principal=900, eligible=False)
    await repo.upsert_draw(epoch=5, distributable=2250, skim=250, num_winners=1)
    await repo.upsert_draw(epoch=6, distributable=0)
    await db.commit()

    assert [s.epoch for s in await repo.list_snapshots(limit=1)] == [6]
    assert [e.epoch for e in await repo.list_epochs()] == [6, 5]
    assert (await repo.get_epoch(5)).prize_pot == 2500
    assert await repo.get_epoch(99) is None
    assert await repo.eligible_total() == 10000
    assert [d.epoch for d in await repo.list_draws()] == [6, 5]
    assert (await repo.get_draw(5)).distributable == 2250
    assert await repo.get_draw(99) is None


async def test_event_recent_readers(db):
    repo = EventRepo(db)
    await repo.add_withdrawal(tx_hash="w1" + "0" * 62, lt=30, ts=3, depositor="0:d", amount=500)
    await repo.add_withdrawal(tx_hash="w2" + "0" * 62, lt=10, ts=1, depositor="0:d", amount=100)
    await repo.add_harvest(
        tx_hash="h1" + "0" * 62, lt=20, ts=2, gross_yield=2500, net_yield=2475, lp_burned=2000
    )
    await repo.add_payout(
        tx_hash="p1" + "0" * 62, lt=40, ts=4, winner="0:w", amount=750, tier=0, epoch=5
    )
    await repo.add_payout(
        tx_hash="p2" + "0" * 62, lt=41, ts=4, winner="0:x", amount=750, tier=1, epoch=5
    )
    await db.commit()

    assert [w.lt for w in await repo.recent_withdrawals()] == [30, 10]
    assert len(await repo.recent_harvests()) == 1
    assert [p.lt for p in await repo.recent_payouts()] == [41, 40]
    assert [p.tier for p in await repo.payouts_for_epoch(5)] == [0, 1]
