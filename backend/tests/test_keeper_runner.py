import asyncio

import pytest

from app.clients.quote import AdapterState, LpQuote
from app.core.config import Settings
from app.keeper import RecordingSender
from app.keeper.planner import KeeperState, Phase
from app.keeper.runner import KeeperRunner, build_state, check_config, main, make_sender
from app.keeper.wallet_sender import WalletSender
from tests._chain import FakeGetMethodClient, config_cell

POOL = "0:" + "a2" * 32
ADP = "0:" + "a1" * 32
DE = "0:" + "a3" * 32
SP = "0:" + "a5" * 32

CFG = Settings(
    env="testnet",
    pool_core_address=POOL,
    adapter_address=ADP,
    draw_engine_address=DE,
    stonfi_pool_address=SP,
    deposit_cutoff=600,
    keeper_min_yield=1,
)

ADAPTER = AdapterState(principal=10_000, lp_balance=10_000, fee_bps=0)
QUOTE = LpQuote(reserve=12_500, lp_supply=10_000)


def _methods(
    phase,
    *,
    epoch=7,
    deposit_deadline=1000,
    prize_pot=5000,
    draw_epoch=6,
    yielding=True,
    onchain_cutoff=600,
):
    lp_balance = 10_000
    reserve = 13_000 if yielding else 10_000  # yielding -> lp_value > principal -> harvestable
    return {
        "get_pool_data": [epoch, deposit_deadline, 99_999, prize_pot],
        "get_config": [config_cell(deposit_cutoff=onchain_cutoff)],
        "get_adapter_data": [0, 10_000, lp_balance, 0, 0, 0, 0, 0, 0],
        "get_lp_quote": [reserve, 10_000],
        "get_phase": [phase],
        "get_draw_state": [draw_epoch, 0, 0, 0, 0],
    }


async def test_build_state_maps_draw_phases():
    for phase_int, expected in [(1, Phase.COMMIT), (2, Phase.REVEAL), (3, Phase.SETTLE)]:
        st = await build_state(FakeGetMethodClient(_methods(phase_int)), CFG, now=5000)
        assert st.phase is expected
        assert st.epoch == 6  # draw epoch, not the live pool epoch
    settle = await build_state(FakeGetMethodClient(_methods(3, prize_pot=5000)), CFG, now=5000)
    assert settle.prize_pot == 5000


async def test_build_state_accrues_before_epoch_end():
    st = await build_state(FakeGetMethodClient(_methods(0, deposit_deadline=1000)), CFG, now=1200)
    assert st.phase is Phase.ACCRUING and st.epoch == 7


async def test_build_state_harvests_then_advances_after_epoch_end():
    end = 1000 + CFG.deposit_cutoff
    harvest = await build_state(FakeGetMethodClient(_methods(0, yielding=True)), CFG, now=end + 1)
    assert harvest.phase is Phase.HARVEST
    advance = await build_state(FakeGetMethodClient(_methods(0, yielding=False)), CFG, now=end + 1)
    assert advance.phase is Phase.ADVANCE


async def test_build_state_uses_onchain_cutoff_not_settings():
    # governance shortened deposit_cutoff to 60 while settings still carry the old 600.
    # epoch_end is deposit_deadline + the ON-CHAIN cutoff, so the keeper must roll at
    # 1060, not 1600. Trusting the settings copy makes it advance 540s late every epoch.
    methods = _methods(0, deposit_deadline=1000, yielding=False, onchain_cutoff=60)
    assert CFG.deposit_cutoff == 600  # the stale copy, deliberately disagreeing

    early = await build_state(FakeGetMethodClient(methods), CFG, now=1059)
    assert early.phase is Phase.ACCRUING

    on_time = await build_state(FakeGetMethodClient(methods), CFG, now=1061)
    assert on_time.phase is Phase.ADVANCE


async def test_read_pool_config_parses_every_field():
    from app.clients.sources import read_pool_config

    methods = {"get_config": [config_cell(
        epoch_length=300, deposit_cutoff=60, commit_window=90, reveal_window=90,
        min_hold_epochs=1, prize_tiers=3, skim_bps=1000, draw_bond=200_000_000,
    )]}
    cfg = await read_pool_config(FakeGetMethodClient(methods), POOL)
    assert (cfg.epoch_length, cfg.deposit_cutoff) == (300, 60)
    assert (cfg.commit_window, cfg.reveal_window) == (90, 90)
    assert (cfg.min_hold_epochs, cfg.prize_tiers, cfg.skim_bps) == (1, 3, 1000)
    assert cfg.draw_bond == 200_000_000


def _runner(sm, provider, *, sender=None, clock=lambda: 5000, interval=0.0):
    return KeeperRunner(
        session_factory=sm,
        client=FakeGetMethodClient({}),
        sender=sender or RecordingSender(),
        cfg=CFG,
        interval=interval,
        state_provider=provider,
        clock=clock,
    )


async def test_run_once_executes_tick_and_persists(sm):
    async def provider(_c, _cfg, _now):
        return KeeperState(phase=Phase.COMMIT, epoch=9, adapter=ADAPTER, quote=QUOTE, now=5000)

    r = _runner(sm, provider)
    sent = await r.run_once()
    assert len(sent) == 1 and len(r.sender.sent) == 1

    from app.keeper import SecretStore

    async with sm() as s:
        assert await SecretStore(s).get(9) is not None


async def test_run_once_idle_skips_session(sm):
    async def provider(_c, _cfg, _now):
        return KeeperState(phase=Phase.ACCRUING, epoch=7, adapter=ADAPTER, quote=QUOTE)

    r = _runner(sm, provider)
    assert await r.run_once() == []
    assert r.sender.sent == []


async def test_run_forever_stops_on_event(sm):
    stop = asyncio.Event()
    calls = {"n": 0}

    async def provider(_c, _cfg, _now):
        calls["n"] += 1
        if calls["n"] >= 3:
            stop.set()
        return KeeperState(phase=Phase.ACCRUING, epoch=7, adapter=ADAPTER, quote=QUOTE)

    await asyncio.wait_for(_runner(sm, provider).run_forever(stop), timeout=2)
    assert calls["n"] == 3


def test_make_sender_defaults_to_dry_run():
    fake = FakeGetMethodClient({})
    assert isinstance(make_sender(Settings(operator_mnemonic=""), fake), RecordingSender)
    live_cfg = Settings(operator_mnemonic="a b c", keeper_dry_run=True)
    assert isinstance(make_sender(live_cfg, fake), RecordingSender)


def test_make_sender_goes_live_with_mnemonic(monkeypatch):
    captured = {}

    def fake_init(self, client, mnemonic, *, workchain=0):
        captured["mnemonic"] = mnemonic

    monkeypatch.setattr(WalletSender, "__init__", fake_init)
    words = " ".join(["word"] * 24)
    sender = make_sender(Settings(operator_mnemonic=words), FakeGetMethodClient({}))
    assert isinstance(sender, WalletSender) and captured["mnemonic"] == ["word"] * 24


JM = "0:" + "a7" * 32


def _full_cfg(**over):
    base = dict(
        env="testnet", pool_core_address=POOL, adapter_address=ADP,
        draw_engine_address=DE, jetton_master_address=JM,
    )
    base.update(over)
    return Settings(**base)


def test_check_config_flags_unset_addresses():
    problems = check_config(Settings(env="testnet"))
    assert any("pool_core_address" in p for p in problems)
    assert any("draw_engine_address" in p for p in problems)


def test_check_config_flags_short_mnemonic():
    assert any("expected 24" in p for p in check_config(_full_cfg(operator_mnemonic="a b c")))


def test_check_config_flags_nonpositive_interval():
    assert any("poll_interval" in p for p in check_config(_full_cfg(keeper_poll_interval=0)))


def test_check_config_clean_when_complete():
    assert check_config(_full_cfg(keeper_dry_run=True)) == []


def test_main_check_exits_zero_on_valid_dry_run(monkeypatch):
    monkeypatch.setattr("app.keeper.runner.get_settings", lambda: _full_cfg(keeper_dry_run=True))
    with pytest.raises(SystemExit) as e:
        main(["--check"])
    assert e.value.code == 0


def test_main_check_exits_one_on_bad_config(monkeypatch):
    monkeypatch.setattr("app.keeper.runner.get_settings", lambda: Settings(env="testnet"))
    with pytest.raises(SystemExit) as e:
        main(["--check"])
    assert e.value.code == 1