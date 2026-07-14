import asyncio
import contextlib
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.clients.chain import ChainClient, ToncenterClient
from app.core.config import Settings, get_settings
from app.db.session import get_sessionmaker
from app.indexer.poller import Indexer, IndexResult

log = logging.getLogger("stonpool.indexer")


def watched_accounts(cfg: Settings) -> list[str]:
    # pool-core receives deposit notifications and withdraw requests; the adapter
    # receives harvest messages
    return [a for a in (cfg.pool_core_address, cfg.adapter_address) if a]


async def scan_once(
    client: ChainClient,
    cfg: Settings,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> dict[str, IndexResult]:
    sm = session_factory or get_sessionmaker()
    out: dict[str, IndexResult] = {}
    async with sm() as db:
        ix = Indexer(client, db, fee_bps=cfg.skim_bps)
        for acct in watched_accounts(cfg):
            out[acct] = await ix.scan_account(acct)
        await db.commit()
    return out


async def run_forever(stop: asyncio.Event, cfg: Settings | None = None) -> None:
    cfg = cfg or get_settings()
    accounts = watched_accounts(cfg)
    if not accounts:
        log.warning("indexer disabled: no pool/adapter addresses configured")
        return
    client = ToncenterClient(cfg)
    log.info("indexer up: accounts=%d interval=%ss", len(accounts), cfg.indexer_poll_interval)
    try:
        while not stop.is_set():
            try:
                results = await scan_once(client, cfg)
                hits = {a: r for a, r in results.items() if r.scanned}
                if hits:
                    log.info("scan: %s", {a[:10]: vars(r) for a, r in hits.items()})
            except Exception:
                log.exception("scan failed")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=cfg.indexer_poll_interval)
    finally:
        await client.aclose()
    log.info(