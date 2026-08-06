import os

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import app.db.session as session_mod
import app.models  # noqa: F401  registers all tables on Base.metadata
from app.core.config import get_settings
from app.db.base import Base


@pytest.fixture(autouse=True)
def isolate_settings_env(monkeypatch):
    # BaseSettings reads os.environ whatever _env_file says, so a shell left holding
    # STONPOOL_* exports from an ops script rewrites every Settings() a test builds and
    # turns unrelated suites red
    for key in [k for k in os.environ if k.startswith("STONPOOL_")]:
        monkeypatch.delenv(key, raising=False)
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def sm(engine, monkeypatch):
    maker = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(session_mod, "_engine", engine)
    monkeypatch.setattr(session_mod, "_sessionmaker", maker)
    return maker


@pytest_asyncio.fixture
async def db(sm):
    async with sm() as s:
        yield s


@pytest_asyncio.fixture
async def app(db):
    from app.api.app import create_app
    from app.db.session import get_db

    application = create_app()

    async def _use_test_db():
        yield db

    application.dependency_overrides[get_db] = _use_test_db
    return application


@pytest_asyncio.fixture
async def client(app):
    import httpx

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c