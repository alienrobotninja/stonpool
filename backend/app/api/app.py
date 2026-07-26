import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import draws, epochs, events, health, pool, positions, wallet
from app.db.session import init_engine
from app.indexer.runner import run_forever as run_indexer
from app.services.derive_runner import run_forever as run_deriver

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # uvicorn configures its own loggers and leaves the root at WARNING, so every log.info
    # from the indexer and the deriver was dropped before it reached a handler; a working
    # indexer and a dead one produced identical output
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    # ASGITransport (tests) does not run lifespan, so the test session factory stays in
    # place; under uvicorn this binds the real engine on startup. The indexer and the
    # deriver ride in this process so the api machine (min_machines_running=1) keeps both
    # the event tables and the read model current; each no-ops if its addresses are unset.
    init_engine()
    stop = asyncio.Event()
    tasks = [
        asyncio.create_task(run_indexer(stop)),
        asyncio.create_task(run_deriver(stop)),
    ]
    yield
    stop.set()
    await asyncio.gather(*tasks)


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