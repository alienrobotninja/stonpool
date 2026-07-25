import asyncio
import contextlib
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.clients.chain import ChainClient, ToncenterClient
from app.clients.sources import QuoteSource, build_quote_source
from app.core.config import Settings, get_settings
from app.db.session import get_sessionmaker
from app.services.derive import DerivedService, DriftReport

log = logging.getLogger("stonpool.derive")

# reconcile_positions reads pool-core, capture_snapshot reads the adapter and the venue
# quote; without all three there is no read model to build, and the api serves an empty
# positions table that looks exactly like a broken indexer
REQUIRED = ("pool_core_address", "adapter_address", "stonfi_pool_address")


def missing_addresses(cfg: Settings) -> list[str]:
    return [name for name in REQUIRED if not getattr(cfg, name)]


async def refresh_once(
    client: ChainClient,
    quotes: QuoteSource,
    cfg: Settings,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> DriftReport:
    sm = session_factory or get_sessionmaker()
    async with sm() as db:
        report = await DerivedService(client, quotes, db, cfg).refresh()
        await db.commit()
    return report


async def run_forever(
    stop: asyncio.Event,
    cfg: Settings | None = None,
    client: ChainClient | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> None:
    cfg = cfg or get_settings()
    missing = missing_addresses(cfg)
    if missing:
        log.warning("derive disabled: %s unset", ", ".join(missing))
        return

    owned = client is None
    client = client or ToncenterClient(cfg)
    try:
        quotes = build_quote_source(client, cfg)
    except Exception:
        # a mainnet build has no quote source yet. that is a config fault, not a transient
        # one, and this task's exceptions surface only at shutdown, so log it here or the
        # api comes up looking healthy with a read model that never fills
        log.exception("derive disabled: no quote source")
        if owned:
            await client.aclose()
        return

    log.info("derive up: interval=%ss", cfg.derive_poll_interval)
    try:
        while not stop.is_set():
            try:
                r = await refresh_once(client, quotes, cfg, session_factory)
                log.info(
                    "derive: pool=%s adapter=%s positions=%s ok=%s",
                    r.pool_total,
                    r.adapter_principal,
                    r.positions_total,
                    r.ok,
                )
            except Exception:
                log.exception("refresh failed")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=cfg.derive_poll_interval)
    finally:
        if owned:
            await client.aclose()
    log.info("derive down")