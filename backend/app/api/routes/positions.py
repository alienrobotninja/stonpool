from fastapi import APIRouter, HTTPException, Query

from app.api.deps import StateRepoDep
from app.api.schemas import PositionOut
from app.models import DepositorPosition

router = APIRouter(tags=["positions"])


def _out(p: DepositorPosition, eligible_total: int) -> PositionOut:
    odds = p.principal / eligible_total if p.eligible and eligible_total > 0 else 0.0
    return PositionOut(
        address=p.address,
        principal=p.principal,
        join_epoch=p.join_epoch,
        eligible=p.eligible,
        odds=odds,
    )


@router.get("/positions", response_model=list[PositionOut])
async def positions(
    repo: StateRepoDep,
    eligible_only: bool = False,
    limit: int = Query(100, ge=1, le=1000),
):
    rows = await repo.list_positions(eligible_only=eligible_only, limit=limit)
    total = await repo.eligible_total()
    return [_out(p, total) for p in rows]


@router.get("/positions/{address}", response_model=PositionOut)
async def position(address: str, repo: StateRepoDep) -> PositionOut:
    p = await repo.get_position(address)
    if p is None:
        raise HTTPException(status_code=404, detail="position not found")
    return _out(p, await repo.eligible_total())
