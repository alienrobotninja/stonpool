from fastapi import APIRouter, Query

from app.api.deps import EventRepoDep
from app.api.schemas import EventOut

router = APIRouter(tags=["events"])


@router.get("/events", response_model=list[EventOut])
async def events(repo: EventRepoDep, limit: int = Query(50, ge=1, le=200)):
    feed: list[EventOut] = []
    for d in await repo.recent_deposits(limit):
        feed.append(
            EventOut(
                kind="deposit",
                tx_hash=d.tx_hash,
                lt=d.lt,
                ts=d.ts,
                epoch=d.epoch,
                address=d.depositor,
                amount=d.amount,
            )
        )
    for w in await repo.recent_withdrawals(limit):
        feed.append(
            EventOut(
                kind="withdrawal",
                tx_hash=w.tx_hash,
                lt=w.lt,
                ts=w.ts,
                epoch=w.epoch,
                address=w.depositor,
                amount=w.amount,
            )
        )
    for h in await repo.recent_harvests(limit):
        feed.append(
            EventOut(
                kind="harvest",
                tx_hash=h.tx_hash,
                lt=h.lt,
                ts=h.ts,
                epoch=h.epoch,
                gross_yield=h.gross_yield,
                net_yield=h.net_yield,
                lp_burned=h.lp_burned,
            )
        )
    for p in await repo.recent_payouts(limit):
        feed.append(
            EventOut(
                kind="payout",
                tx_hash=p.tx_hash,
                lt=p.lt,
                ts=p.ts,
                epoch=p.epoch,
                address=p.winner,
                amount=p.amount,
                tier=p.tier,
            )
        )
    feed.sort(key=lambda e: e.lt, reverse=True)
    return feed[:limit]
