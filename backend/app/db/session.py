from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings, get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def init_engine(cfg: Settings | None = None) -> AsyncEngine:
    global _engine, _sessionmaker
    cfg = cfg or get_settings()
    kw: dict = {"echo": cfg.db_echo, "pool_pre_ping": True}
    if not cfg.database_url.startswith("sqlite"):
        kw["pool_size"] = cfg.db_pool_size
    _engine = create_async_engine(cfg.database_url, **kw)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        init_engine()
    assert _sessionmaker is not None
    return _sessionmaker


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as s:
        try:
            yield s
            await s.commit()
        except Exception:
            await s.rollback()
            raise


async def get_db() -> AsyncIterator[AsyncSession]:
    # FastAPI dependency wired in the api branch; handlers commit explicitly
    async with get_sessionmaker()() as s:
        yield s
