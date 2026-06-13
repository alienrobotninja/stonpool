import pytest

from app.repositories import EventRepo, StateRepo

D1 = "0:" + "01" * 32
D2 = "0:" + "02" * 32
D3 = "0:" + "03" * 32
W1 = "0:" + "0a" * 32


async def _seed(db):
    s = StateRepo(db)
    await s.upsert_position(address=D2, principal=6_000, join_epoch=5, eligible=True)
    await s.upsert_position(address=D1, principal=4_000, join_epoch=5, eligible=True)
    await s.upsert_position(address=D3, principal=900, join_epoch=6, eligible=False)
    await s.upsert_draw(epoch=5, seed="0x" + "f" * 64, distributable=2_250, skim=250, num_winners=1)

    e = EventRepo(db)
    await e.add_deposit(tx_hash="d" * 64, lt=10, ts=100, depositor=D1, amount=4_000, epoch=5)
    await e.add_withdrawal(tx_hash="w" * 64, lt=30, ts=300, depositor=D1, amount=500, epoch=6)
    await e.add_harvest(
        tx_hash="h" * 64,
        lt=20,
        ts=200,
        gross_yield=2_500,
        net_yield=2_500,
        lp_burned=2_000,
        epoch=5,
    )
    await e.add_payout(tx_hash="p" * 64, lt=40, ts=400, winner=W1, amount=2_250, tier=0, epoch=5)
    await db.commit()


async def test_positions_with_odds(client, db):
    await _seed(db)
    rows = (await client.get("/positions")).json()
    assert [r["address"] for r in rows] == [D2, D1, D3]  # principal desc
    by_addr = {r["address"]: r for r in rows}
    assert by_addr[D2]["odds"] == pytest.approx(0.6)
    assert by_addr[D1]["odds"] == pytest.approx(0.4)
    assert by_addr[D3]["odds"] == 0.0  # ineligible

    elig = (await client.get("/positions", params={"eligible_only": True})).json()
    assert {r["address"] for r in elig} == {D1, D2}


async def test_position_detail_and_404(client, db):
    await _seed(db)
    r = await client.get(f"/positions/{D2}")
    assert r.status_code == 200 and r.json()["odds"] == pytest.approx(0.6)
    assert (await client.get("/positions/0:nope")).status_code == 404


async def test_events_feed_merged_desc(client, db):
    await _seed(db)
    feed = (await client.get("/events")).json()
    assert [e["kind"] for e in feed] == [
        "payout",
        "withdrawal",
        "harvest",
        "deposit",
    ]  # lt 40,30,20,10
    harvest = next(e for e in feed if e["kind"] == "harvest")
    assert harvest["net_yield"] == 2_500 and harvest["lp_burned"] == 2_000


async def test_draws_list_and_detail(client, db):
    await _seed(db)
    lst = (await client.get("/draws")).json()
    assert lst[0]["epoch"] == 5 and lst[0]["payouts"] == []  # list omits payouts

    detail = (await client.get("/draws/5")).json()
    assert detail["distributable"] == 2_250 and len(detail["payouts"]) == 1
    assert detail["payouts"][0]["winner"] == W1

    assert (await client.get("/draws/99")).status_code == 404
