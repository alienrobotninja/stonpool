import asyncio
from logging.config import fileConfig

from sqlalchemy.ext.asyncio import create_async_engine

import app.models  # noqa: F401  registers all tables
from alembic import context
from app.core.config import get_settings
from app.db.base import Base
from app.db.session import _engine_kwargs, _normalize_pg_url

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _url() -> str:
    raw = config.get_main_option("sqlalchemy.url") or get_settings().database_url
    return raw if raw.startswith("sqlite") else _normalize_pg_url(raw)[0]


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _run(conn) -> None:
    context.configure(
        connection=conn,
        target_metadata=target_metadata,
        compare_type=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    override = config.get_main_option("sqlalchemy.url")
    if override:
        # test harness / manual `-x` override - never the prod pooled endpoint,
        # so just normalize the scheme and skip the pooling extras
        url = override if override.startswith("sqlite") else _normalize_pg_url(override)[0]
        eng = create_async_engine(url, pool_pre_ping=True)
    else:
        # same normalization + pooling rules as the app engine (app/db/session.py) -
        # this used to build its own bare create_async_engine(raw url) and broke on
        # exactly the postgresql:// (no +asyncpg) scheme every managed-Postgres
        # provider hands out
        url, kw = _engine_kwargs(get_settings())
        eng = create_async_engine(url, **kw)
    async with eng.connect() as conn:
        await conn.run_sync(_run)
    await eng.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())