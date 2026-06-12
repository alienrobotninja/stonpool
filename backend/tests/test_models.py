import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models import (
    Deposit,
    DepositorPosition,
    Draw,
    Epoch,
    Harvest,
    IndexerCursor,
    Payout,
    PoolSnapshot,
    Withdrawal,
)

BIG = 9_000_000_000_000_000  # 9e15, well inside int64, exercises a large balance


async def test_amounts_roundtrip_as_int(db):
    db.add(
        PoolSnapshot(
            epoch=5,
            deposit_deadline=1_700_000_000,
            total_principal=BIG,
            prize_pot=2500,
            adapter_principal=BIG,
            adapter_lp_balance=BIG,
            stonfi_reserve=BIG,
            stonfi_lp_supply=BIG,
            accrued_yield=0,
        )
    )
    await db.commit()
    row = (await db.execute(select(PoolSnapshot))).scalar_one()
    assert row.total_principal == BIG and isinstance(row.total_principal, int)
    assert row.prize_pot == 2500


async def test_deposit_tx_hash_is_idempotent(db):
    db.add(Deposit(tx_hash="a" * 64, lt=1, ts=1, epoch=5, depositor="0:dep", amount=1000))
    await db.commit()
    db.add(Deposit(tx_hash="a" * 64, lt=2, ts=2, epoch=5, depositor="0:dep", amount=1000))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    assert (await db.execute(select(func.count()).select_from(Deposit))).scalar_one() == 1


async def test_payout_unique_per_tx_and_winner(db):
    db.add_all(
        [
            Payout(tx_hash="b" * 64, lt=1, ts=1, epoch=5, winner="0:w1", amount=750, tier=0),
            Payout(tx_hash="b" * 64, lt=1, ts=1, epoch=5, winner="0:w2", amount=750, tier=1),
        ]
    )
    await db.commit()  # same tx, different winners is allowed
    assert (await db.execute(select(func.count()).select_from(Payout))).scalar_one() == 2

    db.add(Payout(tx_hash="b" * 64, lt=1, ts=1, epoch=5, winner="0:w1", amount=1, tier=0))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_position_ordering_is_numeric(db):
    db.add_all(
        [
            DepositorPosition(address="0:small", principal=900, join_epoch=5, eligible=True),
            DepositorPosition(address="0:big", principal=BIG, join_epoch=5, eligible=True),
            DepositorPosition(address="0:mid", principal=5000, join_epoch=5, eligible=True),
        ]
    )
    await db.commit()
    ranked = (
        (
            await db.execute(
                select(DepositorPosition.address).order_by(DepositorPosition.principal.desc())
            )
        )
        .scalars()
        .all()
    )
    assert ranked == ["0:big", "0:mid", "0:small"]


async def test_remaining_tables_insert(db):
    db.add_all(
        [
            Epoch(epoch=5, started_at=1, deposit_deadline=2, harvested_yield=2500, prize_pot=2500),
            Draw(epoch=5, seed="0x" + "f" * 64, distributable=2250, skim=250, num_winners=3),
            Withdrawal(tx_hash="c" * 64, lt=1, ts=1, epoch=6, depositor="0:dep", amount=1000),
            Harvest(
                tx_hash="d" * 64,
                lt=1,
                ts=1,
                epoch=5,
                gross_yield=2500,
                net_yield=2475,
                lp_burned=2000,
            ),
            IndexerCursor(account="0:pool", last_lt=42, last_hash="e" * 64),
        ]
    )
    await db.commit()
    assert (
        (await db.execute(select(Draw.seed).where(Draw.epoch == 5))).scalar_one().startswith("0x")
    )
    assert (await db.execute(select(Epoch.settled).where(Epoch.epoch == 5))).scalar_one() is False
