from sqlalchemy.pool import NullPool, QueuePool

from app.core.config import Settings
from app.db.session import _engine_kwargs, _normalize_pg_url, init_engine


def test_normalize_strips_sslmode_into_connect_args():
    url, connect_args = _normalize_pg_url(
        "postgresql+asyncpg://u:p@host:5432/db?sslmode=require"
    )
    assert "sslmode" not in url
    assert connect_args == {"ssl": "require"}


def test_normalize_passthrough_without_sslmode():
    url, connect_args = _normalize_pg_url("postgresql+asyncpg://u:p@host:5432/db")
    assert url == "postgresql+asyncpg://u:p@host:5432/db"
    assert connect_args == {}


def test_normalize_rewrites_bare_postgres_scheme():
    url, _ = _normalize_pg_url("postgres://u:p@host:5432/db")
    assert url.startswith("postgresql+asyncpg://")


def test_normalize_rewrites_bare_postgresql_scheme():
    url, connect_args = _normalize_pg_url("postgresql://u:p@host:5432/db?sslmode=require")
    assert url.startswith("postgresql+asyncpg://")
    assert connect_args == {"ssl": "require"}


def test_normalize_keeps_other_query_params():
    url, _ = _normalize_pg_url(
        "postgresql+asyncpg://u:p@host:5432/db?sslmode=verify-full&target_session_attrs=read-write"
    )
    assert "sslmode" not in url
    assert "target_session_attrs=read-write" in url


def test_normalize_strips_channel_binding():
    # this is Neon's actual default connection-string shape - both params together
    url, connect_args = _normalize_pg_url(
        "postgresql://u:p@ep-example-pooler.c-4.eu-central-1.aws.neon.tech/neondb"
        "?sslmode=require&channel_binding=require"
    )
    assert "channel_binding" not in url
    assert connect_args == {"ssl": "require"}


async def test_pooled_engine_uses_nullpool_and_disables_stmt_cache():
    cfg = Settings(
        _env_file=None,
        database_url="postgresql+asyncpg://u:p@host:5432/db?sslmode=require",
        db_pooled=True,
    )
    engine = init_engine(cfg)
    try:
        assert isinstance(engine.pool, NullPool)
    finally:
        await engine.dispose()


async def test_direct_engine_uses_queuepool():
    cfg = Settings(
        _env_file=None, database_url="postgresql+asyncpg://u:p@host:5432/db", db_pooled=False
    )
    engine = init_engine(cfg)
    try:
        assert isinstance(engine.pool, QueuePool)
    finally:
        await engine.dispose()


def test_engine_kwargs_normalizes_bare_scheme_for_alembic():
    # alembic/env.py builds its migration engine from this helper directly; a bare
    # postgresql:// (what every managed-Postgres provider hands out, and what landed
    # in .env.fly here) must come out asyncpg-ready or `alembic upgrade head` dies
    # with "requires an async driver" before the app ever boots
    cfg = Settings(
        _env_file=None,
        database_url="postgresql://u:p@host:5432/db?sslmode=require",
        db_pooled=True,
    )
    url, kw = _engine_kwargs(cfg)
    assert url.startswith("postgresql+asyncpg://")
    assert kw["connect_args"]["ssl"] == "require"
    assert kw["connect_args"]["statement_cache_size"] == 0
    assert kw["poolclass"] is NullPool


def test_engine_kwargs_sqlite_passthrough_unaffected():
    url, kw = _engine_kwargs(Settings(_env_file=None, database_url="sqlite+aiosqlite:///:memory:"))
    assert url == "sqlite+aiosqlite:///:memory:"
    assert "connect_args" not in kw
    assert "poolclass" not in kw