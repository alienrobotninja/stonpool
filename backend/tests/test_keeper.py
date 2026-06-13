from app.keeper import (
    RecordingSender,
    SecretStore,
    build_advance_epoch,
    build_commit,
    build_harvest_stonfi,
    build_reveal,
    build_settle_draw,
    commit_hash,
    from_hex,
    gen_secret,
    mix_seed,
    to_hex,
)

VAULT = "0:" + "ab" * 32


def test_commit_hash_matches_onchain_vector():
    # verified byte-equal against @ton/core cell.hash()
    assert commit_hash(12345) == 0x72F82454B583F5EF1F6E84B3507BDEBC893C959CDD3FE47B64F2889AD99FE86D
    assert mix_seed(0, 12345) == 0xE981EA86BFFD389F82477C4D7DF495ABF4FA12030D3FE1276CB1276B6AC1449E


def test_simple_op_bodies_parse_back():
    for builder, op in [
        (build_advance_epoch, 0x10000004),
        (build_settle_draw, 0x10000016),
    ]:
        s = builder(7).begin_parse()
        assert s.load_uint(32) == op and s.load_uint(64) == 7


def test_commit_reveal_bodies():
    h = commit_hash(999)
    cs = build_commit(h).begin_parse()
    assert cs.load_uint(32) == 0x10000011 and cs.load_uint(64) == 0
    assert cs.load_uint(256) == h

    rs = build_reveal(999).begin_parse()
    assert rs.load_uint(32) == 0x10000012
    rs.load_uint(64)
    assert rs.load_uint(256) == 999


def test_harvest_body():
    s = build_harvest_stonfi(lp_to_burn=2000, gross_yield=2500, to=VAULT, query_id=3).begin_parse()
    assert s.load_uint(32) == 0x10000035 and s.load_uint(64) == 3
    assert s.load_coins() == 2000 and s.load_coins() == 2500
    assert s.load_address().to_str(is_user_friendly=False) == VAULT


async def test_recording_sender():
    sender = RecordingSender()
    tx = await sender.send(to=VAULT, body=build_settle_draw(), value=1_000_000_000)
    assert tx == "fake-tx-1" and len(sender.sent) == 1 and sender.sent[0]["to"] == VAULT


def test_secret_hex_roundtrip():
    s = gen_secret()
    assert 0 <= s < (1 << 256)
    assert from_hex(to_hex(s)) == s


async def test_secret_store_persists_and_reveals(db):
    store = SecretStore(db)
    row = await store.create(epoch=6, secret=12345)
    await db.commit()
    assert row.commit_hash == to_hex(commit_hash(12345)) and row.revealed is False

    # idempotent: re-create returns existing row, does not overwrite
    again = await store.create(epoch=6, secret=999)
    await db.commit()
    assert from_hex(again.secret) == 12345

    await store.mark_revealed(6)
    await db.commit()
    assert (await store.get(6)).revealed is True
    assert await store.get(99) is None
