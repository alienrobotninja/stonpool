import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import draws, epochs, events, health, pool, positions, wallet
from app.db.session import init_engine
from app.indexer.runner import run_forever as run_indexer


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ASGITransport (tests) does not run lifespan, so the test session factory stays in
    # place; under uvicorn this binds the real engine on startup. The indexer rides in
    # this process so the api machine (min_machines_running=1) keeps the DB current;
    # run_indexer no-ops if no contract addresses are configured.
    init_engine()
    stop = asyncio.Event()
    task = asyncio.create_task(run_indexer(stop))
    yield
    stop.set()
    await task


def create_app() -> FastAPI:
    app = FastAPI(title="STONPool API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # dApp is a static client; the api is read-only
        allow_methods=["GET"],
        allow_headers=["*"],
    )
    app.include_router(health.router)
    app.include_router(pool.router)
    app.include_router(epochs.router)
    app.include_router(positions.router)
    app.include_router(events.router)
    app.include_router(draws.router)
    app.include_router(wallet.router)
    return app