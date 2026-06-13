from fastapi import APIRouter, HTTPException, Query

from app.api.deps import EventRepoDep, StateRepoDep
from app.api.schemas import DrawOut, PayoutOut
from app.models import Draw

router = APIRouter(tags=["draws"])


def _out(d: Draw, payouts: list) -> DrawOut:
    return DrawOut(
        epoch=d.epoch,
        seed=d.seed,
        distributable=d.distributable,
        skim=d.skim,
        num_winners=d.num_winners,
        settled_ts=d.settled_ts,
        payouts=[PayoutOut.model_validate(p) for p in payouts],
    )


@router.get("/draws", response_model=list[DrawOut])
async def draws(repo: StateRepoDep, limit: int = Query(50, ge=1, le=500)):
    return [_out(d, []) for d in await repo.list_draws(limit=limit)]


@router.get("/draws/{epoch}", response_model=DrawOut)
async def draw(epoch: int, state: StateRepoDep, events: EventRepoDep) -> DrawOut:
    d = await state.get_draw(epoch)
    if d is None:
        raise HTTPException(status_code=404, detail="draw not found")
    return _out(d, await events.payouts_for_epoch(epoch))
