from app.repositories import StateRepo

SNAP = dict(
    deposit_deadline=1_700_000_000,
    total_principal=10_000,
    prize_pot=2_500,
    adapter_principal=10_000,
    adapter_lp_balance=10_000,
    stonfi_reserve=12_500,
    stonfi_lp_supply=10_000,
    accrued_yield=2_500,
)


async def _seed(db):
    repo = StateRepo(db)
    await repo.add_snapshot(epoch=5, **SNAP)
    await repo.add_snapshot(epoch=6, **SNAP)
    await repo.upsert_epoch(epoch=5, started_at=100, prize_pot=2_500, settled=True)
    await repo.upsert_epoch(epoch=6, started_at=200, prize_pot=0)
    await db.commit()


async def test_pool_returns_latest_snapshot(client, db):
    await _seed(db)
    r = await client.get("/pool")
    assert r.status_code == 200
    body = r.json()
    assert body["epoch"] == 6 and body["accrued_yield"] == 2_500 and "created_at" in body


async def test_pool_404_when_empty(client):
    r = await client.get("/pool")
    assert r.status_code == 404


async def test_snapshots_ordered_and_limited(client, db):
    await _seed(db)
    r = await client.get("/snapshots", params={"limit": 1})
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1 and rows[0]["epoch"] == 6


async def test_epochs_list_and_get(client, db):
    await _seed(db)
    r = await client.get("/epochs")
    assert [e["epoch"] for e in r.json()] == [6, 5]

    r5 = await client.get("/epochs/5")
    assert r5.status_code == 200 and r5.json()["settled"] is True

    assert (await client.get("/epochs/99")).status_code == 404
