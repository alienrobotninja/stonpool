from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from app.core.config import Settings, get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None

# asyncpg.connect() takes ssl=, not sslmode=; sslmode is only parsed out of a raw
# DSN string, and SQLAlchemy forwards unknown query params straight through as
# kwargs, so an untouched libpq URL (every managed-Postgres provider emits one)
# dies with "connect() got an unexpected keyword argument 'sslmode'".
_SSLMODE_TO_SSL = {
    "disable": False,
    "allow": "prefer",
    "prefer": "prefer",
    "require": "require",
    "verify-ca": "verify-ca",
    "verify-full": "verify-full",
}


def _normalize_pg_url(raw: str) -> tuple[str, dict]:
    parts = urlsplit(raw)
    scheme = parts.scheme
    if scheme in ("postgres", "postgresql"):
        scheme = "postgresql+asyncpg"
    q = dict(parse_qsl(parts.query))
    sslmode = q.pop("sslmode", None)
    # libpq/psycopg SCRAM directive, no asyncpg.connect() equivalent (checked its
    # signature directly - not there). Neon includes it in every connection string
    # by default; left in, it's the same "unexpected keyword argument" crash as
    # sslmode. Dropping it still leaves TLS itself enforced via ssl= below.
    q.pop("channel_binding", None)
    connect_args: dict = {}
    if sslmode is not None:
        connect_args["ssl"] = _SSLMODE_TO_SSL.get(sslmode, "require")
    clean = urlunsplit(parts._replace(scheme=scheme, query=urlencode(q)))
    return clean, connect_args


def _engine_kwargs(cfg: Settings) -> tuple[str, dict]:
    # single source of truth for (url, kwargs) -> create_async_engine(url, **kwargs).
    # alembic/env.py calls this directly instead of building its own engine, which is
    # exactly how it ended up passing a raw postgresql:// straight through unnormalized
    url = cfg.database_url
    kw: dict = {"echo": cfg.db_echo, "pool_pre_ping": True}
    if url.startswith("sqlite"):
        return url, kw
    url, connect_args = _normalize_pg_url(url)
    if cfg.db_pooled:
        # transaction-mode pgbouncer (Supabase/Neon poolers etc) hands each
        # statement to a random backend, so asyncpg's prepared-statement cache
        # goes stale mid-session; NullPool avoids double-pooling on top of it
        kw["poolclass"] = NullPool
        connect_args["statement_cache_size"] = 0
        connect_args["prepared_statement_cache_size"] = 0
    else:
        kw["pool_size"] = cfg.db_pool_size
    if connect_args:
        kw["connect_args"] = connect_args
    return url, kw


def init_engine(cfg: Settings | None = None) -> AsyncEngine:
    global _engine, _sessionmaker
    cfg = cfg or get_settings()
    url, kw = _engine_kwargs(cfg)
    _engine = create_async_engine(url, **kw)
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