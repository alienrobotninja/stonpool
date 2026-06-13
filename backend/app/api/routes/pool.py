from fastapi import APIRouter, HTTPException, Query

from app.api.deps import StateRepoDep
from app.api.schemas import SnapshotOut

router = APIRouter(tags=["pool"])


@router.get("/pool", response_model=SnapshotOut)
async def pool(repo: StateRepoDep) -> SnapshotOut:
    snap = await repo.latest_snapshot()
    if snap is None:
        raise HTTPException(status_code=404, detail="no snapshot captured yet")
    return snap


@router.get("/snapshots", response_model=list[SnapshotOut])
async def snapshots(repo: StateRepoDep, limit: int = Query(50, ge=1, le=500)):
    return await repo.list_snapshots(limit=limit)
