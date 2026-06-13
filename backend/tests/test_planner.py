import pytest

from app.clients.quote import AdapterState, LpQuote
from app.core.config import Settings
from app.keeper import KeeperState, Phase, commit_hash, plan
from app.keeper.planner import (
    VALUE_ADVANCE,
    VALUE_COMMIT,
    VALUE_REVEAL,
    VALUE_SETTLE,
)

ADP = "0:" + "a1" * 32
POOL = "0:" + "a2" * 32
DE = "0:" + "a3" * 32
VAULT = "0:" + "a4" * 32

CFG = Settings(
    env="testnet",
    adapter_address=ADP,
    pool_core_address=POOL,
    draw_engine_address=DE,
    vault_address=VAULT,
    stonfi_pool_address="0:" + "a5" * 32,
)

# yield-bearing adapter: lp_value 12500 over principal 10000 -> 2500 accrued
ADAPTER = AdapterState(principal=10_000, lp_balance=10_000, fee_bps=0)
QUOTE = LpQuote(reserve=12_500, lp_supply=10_000)


def _state(phase, **kw):
    return KeeperState(phase=phase, epoch=6, adapter=ADAPTER, quote=QUOTE, **kw)


@pytest.mark.parametrize(
    "phase",
    [Phase.ACCRUING, Phase.SETTLED],
)
def test_idle_phases_emit_nothing(phase):
    assert plan(_state(phase), CFG) == []


@pytest.mark.parametrize(
    "phase,kind,to,op,value",
    [
        (Phase.ADVANCE, "advance", POOL, 0x10000004, VALUE_ADVANCE),
        (Phase.SETTLE, "settle", POOL, 0x10000016, VALUE_SETTLE),
    ],
)
def test_simple_actions(phase, kind, to, op, value):
    (a,) = plan(_state(phase), CFG)
    assert (a.kind, a.to, a.value) == (kind, to, value)
    assert a.body.begin_parse().load_uint(32) == op


def test_harvest_uses_plan_figures():
    (a,) = plan(_state(Phase.HARVEST), CFG)
    assert a.kind == "harvest" and a.to == ADP
    s = a.body.begin_parse()
    assert s.load_uint(32) == 0x10000035
    s.load_uint(64)
    assert s.load_coins() == 2000 and s.load_coins() == 2500  # lp_to_burn, gross_yield
    assert s.load_address().to_str(is_user_friendly=False) == VAULT


def test_harvest_skipped_below_dust():
    flat = KeeperState(
        phase=Phase.HARVEST,
        epoch=6,
        adapter=AdapterState(principal=10_000, lp_balance=10_000, fee_bps=0),
        quote=LpQuote(reserve=10_000, lp_supply=10_000),  # no accrual
    )
    assert plan(flat, CFG) == []


def test_commit_carries_hash_and_bond():
    h = commit_hash(12345)
    (a,) = plan(_state(Phase.COMMIT, commit_hash=h), CFG)
    assert a.kind == "commit" and a.to == DE and a.value == VALUE_COMMIT
    s = a.body.begin_parse()
    assert s.load_uint(32) == 0x10000011
    s.load_uint(64)
    assert s.load_uint(256) == h


def test_reveal_carries_secret():
    (a,) = plan(_state(Phase.REVEAL, reveal_secret=12345), CFG)
    assert a.kind == "reveal" and a.value == VALUE_REVEAL
    s = a.body.begin_parse()
    assert s.load_uint(32) == 0x10000012
    s.load_uint(64)
    assert s.load_uint(256) == 12345


def test_commit_and_reveal_require_inputs():
    with pytest.raises(ValueError):
        plan(_state(Phase.COMMIT), CFG)
    with pytest.raises(ValueError):
        plan(_state(Phase.REVEAL), CFG)
