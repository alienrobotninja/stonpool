from fastapi import APIRouter, HTTPException, Query

from app.api.deps import StateRepoDep
from app.api.schemas import EpochOut

router = APIRouter(tags=["epochs"])


@router.get("/epochs", response_model=list[EpochOut])
async def epochs(repo: StateRepoDep, limit: int = Query(50, ge=1, le=500)):
    return await repo.list_epochs(limit=limit)


@router.get("/epochs/{epoch}", response_model=EpochOut)
async def epoch(epoch: int, repo: StateRepoDep) -> EpochOut:
    row = await repo.get_epoch(epoch)
    if row is None:
        raise HTTPException(status_code=404, detail="epoch not found")
    return row
