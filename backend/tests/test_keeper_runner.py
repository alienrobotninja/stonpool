import asyncio

from app.clients.quote import AdapterState, LpQuote
from app.core.config import Settings
from app.keeper import RecordingSender
from app.keeper.planner import KeeperState, Phase
from app.keeper.runner import KeeperRunner, build_state, make_sender
from app.keeper.wallet_sender import WalletSender
from tests._chain import FakeGetMethodClient

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


def _methods(phase, *, epoch=7, deposit_deadline=1000, prize_pot=5000, draw_epoch=6, yielding=True):
    lp_balance = 10_000
    reserve = 13_000 if yielding else 10_000  # yielding -> lp_value > principal -> harvestable
    return {
        "get_pool_data": [epoch, deposit_deadline, 99_999, prize_pot],
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