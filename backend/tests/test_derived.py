from app.clients.sources import MockPoolQuoteSource
from app.core.config import Settings
from app.repositories import EventRepo, StateRepo
from app.services import DerivedService
from tests._chain import FakeGetMethodClient

POOL = "0:" + "aa" * 32
ADAPTER = "0:" + "bb" * 32
SF = "0:" + "cc" * 32
D1 = "0:" + "01" * 32
D2 = "0:" + "02" * 32

ADMIN_ITEM = {"type": "slice", "value": "te6"}


def _cfg() -> Settings:
    return Settings(
        env="testnet",
        pool_core_address=POOL,
        adapter_address=ADAPTER,
        stonfi_pool_address=SF,
        min_hold_epochs=1,
    )


def _client(*, prize_pot=0, reserve=12_500, lp_supply=10_000, principal=10_000, lp_balance=10_000):
    return FakeGetMethodClient(
        methods={
            "get_pool_data": [6, 1_700_000_000, 10_000, prize_pot],
            "get_adapter_data": [
                ADMIN_ITEM,
                principal,
                lp_balance,
                None,
                None,
                None,
                None,
                None,
                0,
            ],
            "get_lp_quote": [reserve, lp_supply],
        },
        balances={D1: (4_000, 5), D2: (6_000, 5)},
    )


async def _seed_depositors(db):
    repo = EventRepo(db)
    await repo.add_deposit(tx_hash="d1" + "0" * 62, lt=1, ts=1, depositor=D1, amount=4_000)
    await repo.add_deposit(tx_hash="d2" + "0" * 62, lt=2, ts=2, depositor=D2, amount=6_000)
    await db.commit()


def _service(db, client):
    return DerivedService(client, MockPoolQuoteSource(client, SF), db, _cfg())


async def test_capture_snapshot_derives_accrued_yield(db):
    svc = _service(db, _client())
    snap = await svc.capture_snapshot()
    await db.commit()
    # lp_value(10000, 12500/10000) - 10000 = 2500
    assert snap.accrued_yield == 2_500
    assert snap.total_principal == 10_000 and snap.stonfi_reserve == 12_500
    assert (await StateRepo(db).latest_snapshot()).epoch == 6


async def test_reconcile_positions_from_chain(db):
    await _seed_depositors(db)
    svc = _service(db, _client())
    n = await svc.reconcile_positions()
    await db.commit()

    assert n == 2
    state = StateRepo(db)
    assert await state.total_principal() == 10_000
    ranked = [p.address for p in await state.list_positions()]
    assert ranked == [D2, D1]  # 6000 before 4000
    d1 = await state.get_position(D1)
    assert d1.principal == 4_000 and d1.join_epoch == 5 and d1.eligible is True


async def test_drift_ok_and_detected(db):
    await _seed_depositors(db)
    svc = _service(db, _client())
    await svc.reconcile_positions()
    await db.commit()
    report = await svc.check_drift()
    assert report.ok and report.pool_total == 10_000 == report.positions_total

    # tamper a position so the table diverges from the chain
    await StateRepo(db).upsert_position(address=D1, principal=1)
    await db.commit()
    assert (await svc.check_drift()).ok is False


async def test_refresh_runs_all_and_reports(db):
    await _seed_depositors(db)
    report = await _service(db, _client()).refresh()
    assert report.ok and report.adapter_principal == 10_000
