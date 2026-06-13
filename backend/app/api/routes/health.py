from fastapi import APIRouter

from app.api.schemas import HealthOut
from app.core.config import get_settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthOut)
async def health() -> HealthOut:
    return HealthOut(status="ok", env=get_settings().env)
