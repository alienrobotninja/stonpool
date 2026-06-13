from app.clients.quote import AdapterState, LpQuote
from app.core.config import Settings
from app.keeper import (
    Keeper,
    KeeperState,
    Phase,
    RecordingSender,
    commit_hash,
    from_hex,
    mix_seed,
)
from app.repositories import StateRepo
from tests._chain import FakeGetMethodClient

ADP = "0:" + "a1" * 32
POOL = "0:" + "a2" * 32
DE = "0:" + "a3" * 32
VAULT = "0:" + "a4" * 32
W = ["0:" + "b1" * 32, "0:" + "b2" * 32, "0:" + "b3" * 32]

CFG = Settings(
    env="testnet",
    adapter_address=ADP,
    pool_core_address=POOL,
    draw_engine_address=DE,
    vault_address=VAULT,
    stonfi_pool_address="0:" + "a5" * 32,
    skim_bps=1000,
    prize_tiers=3,
)

ADAPTER = AdapterState(principal=10_000, lp_balance=10_000, fee_bps=0)
QUOTE = LpQuote(reserve=12_500, lp_supply=10_000)


def _keeper(db, client=None):
    return Keeper(client or FakeGetMethodClient({}), RecordingSender(), db, CFG)


def _state(phase, **kw):
    return KeeperState(phase=phase, epoch=6, adapter=ADAPTER, quote=QUOTE, **kw)


async def test_commit_generates_and_persists_secret(db):
    k = _keeper(db)
    sent = await k.tick(_state(Phase.COMMIT, now=1000))
    await db.commit()

    assert len(sent) == 1
    body = k.sender.sent[0]
    assert body["to"] == DE  # commit -> draw-engine
    row = await k.secrets.get(6)
    assert row is not None and row.revealed is False
    # the committed hash matches commit_hash(secret)
    assert from_hex(row.commit_hash) == commit_hash(from_hex(row.secret))


async def test_reveal_loads_secret_and_marks_revealed(db):
    k = _keeper(db)
    await k.secrets.create(epoch=6, secret=12345)
    await db.commit()

    sent = await k.tick(_state(Phase.REVEAL, now=2000))
    await db.commit()
    assert len(sent) == 1
    assert (await k.secrets.get(6)).revealed is True
    s = k.sender.sent[0]["body"].begin_parse()
    s.load_uint(32)
    s.load_uint(64)
    assert s.load_uint(256) == 12345


async def test_settle_records_draw_and_payouts(db):
    state = StateRepo(db)
    for addr, w in zip(W, (5000, 3000, 2000), strict=True):
        await state.upsert_position(address=addr, principal=w, join_epoch=5, eligible=True)
    await db.commit()

    client = FakeGetMethodClient({}, preview_winners=list(W))
    k = Keeper(client, RecordingSender(), db, CFG)
    await k.secrets.create(epoch=6, secret=12345)
    await db.commit()

    sent = await k.tick(_state(Phase.SETTLE, now=3000, prize_pot=2_500))
    await db.commit()

    assert len(sent) == 1 and k.sender.sent[0]["to"] == POOL  # settle -> pool-core
    seed = mix_seed(0, 12345)
    draw = await state.get_draw(6)
    assert draw.skim == 250 and draw.distributable == 2_250 and draw.num_winners == 3
    assert from_hex(draw.seed) == seed and draw.settle_tx == "fake-tx-1"

    payouts = {p.tier: p for p in await k.events.payouts_for_epoch(6)}
    assert len(payouts) == 3
    assert payouts[0].winner == W[0] and payouts[0].amount == 750  # per_tier 750, remainder 0
    assert payouts[1].amount == 750 and payouts[2].amount == 750


async def test_harvest_dispatches_to_adapter(db):
    k = _keeper(db)
    sent = await k.tick(_state(Phase.HARVEST, now=1))
    assert len(sent) == 1 and k.sender.sent[0]["to"] == ADP
