from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import draws, epochs, events, health, pool, positions
from app.db.session import init_engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ASGITransport (tests) does not run lifespan, so the test session factory stays in
    # place; under uvicorn this binds the real engine on startup.
    init_engine()
    yield


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
    return app
