import asyncio

import pytest

from app.clients.sources import MockPoolQuoteSource
from app.core.config import Settings
from app.repositories import EventRepo, StateRepo
from app.services import derive_runner
from app.services.derive import DerivedService, DriftReport
from app.services.derive_runner import missing_addresses, refresh_once, run_forever
from tests._chain import FakeGetMethodClient

POOL = "0:" + "aa" * 32
ADAPTER = "0:" + "bb" * 32
SF = "0:" + "cc" * 32
D1 = "0:" + "01" * 32

ADMIN_ITEM = {"type": "slice", "value": "te6"}


def _cfg(**kw) -> Settings:
    return Settings(_env_file=None, **kw)


def _wired(**kw) -> Settings:
    return _cfg(
        pool_core_address=POOL,
        adapter_address=ADAPTER,
        stonfi_pool_address=SF,
        min_hold_epochs=1,
        derive_poll_interval=0,
        **kw,
    )


def _client() -> FakeGetMethodClient:
    return FakeGetMethodClient(
        methods={
            "get_pool_data": [6, 1_700_000_000, 4_000, 0],
            "get_adapter_data": [ADMIN_ITEM, 4_000, 4_000, None, None, None, None, None, 0],
            "get_lp_quote": [5_000, 4_000],
        },
        balances={D1: (4_000, 5)},
    )


def test_stays_disabled_until_every_address_is_set():
    assert missing_addresses(_cfg()) == list(derive_runner.REQUIRED)
    assert missing_addresses(_cfg(pool_core_address=POOL, adapter_address=ADAPTER)) == [
        "stonfi_pool_address"
    ]
    assert missing_addresses(_wired()) == []


async def test_refresh_once_fills_the_tables_the_api_reads(sm):
    async with sm() as db:
        await EventRepo(db).add_deposit(
            tx_hash="d1" + "0" * 62, lt=1, ts=1, depositor=D1, amount=4_000
        )
        await db.commit()

    client = _client()
    report = await refresh_once(
        client, MockPoolQuoteSource(client, SF), _wired(), session_factory=sm
    )
    assert report.ok

    async with sm() as db:
        state = StateRepo(db)
        assert [p.address for p in await state.list_positions(limit=10)] == [D1]
        assert await state.latest_snapshot() is not None


async def test_a_failed_tick_does_not_stop_the_loop(sm, monkeypatch):
    stop = asyncio.Event()
    calls = []

    async def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("toncenter blip")
        stop.set()
        return DriftReport(pool_total=0, adapter_principal=0, positions_total=0)

    monkeypatch.setattr(derive_runner, "refresh_once", flaky)
    await run_forever(stop, cfg=_wired(), client=_client(), session_factory=sm)
    assert len(calls) == 2


async def test_a_late_failure_keeps_what_the_earlier_phases_wrote(sm, monkeypatch):
    async with sm() as db:
        await EventRepo(db).add_deposit(
            tx_hash="d2" + "0" * 62, lt=2, ts=2, depositor=D1, amount=4_000
        )
        await db.commit()

    async def boom(self):
        raise RuntimeError("429 on the last read")

    monkeypatch.setattr(DerivedService, "check_drift", boom)

    client = _client()
    with pytest.raises(RuntimeError):
        await refresh_once(client, MockPoolQuoteSource(client, SF), _wired(), session_factory=sm)

    async with sm() as db:
        state = StateRepo(db)
        assert [p.address for p in await state.list_positions(limit=10)] == [D1]
        assert await state.latest_snapshot() is not None