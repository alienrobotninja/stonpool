import asyncio

from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.db.session import _engine_kwargs, get_sessionmaker, init_engine

TABLES = [
    "deposits",
    "withdrawals",
    "harvests",
    "payouts",
    "pool_snapshots",
    "depositor_positions",
    "draws",
    "epochs",
]


async def main():
    cfg = get_settings()
    # goes through the app's own normalization, so a connection that works here is a
    # connection the api gets and a failure here is a failure the api has too
    url, kw = _engine_kwargs(cfg)
    print(f"url       {make_url(url).render_as_string(hide_password=True)}")
    print(f"pooled    {cfg.db_pooled}  connect_args {kw.get('connect_args', {})}")
    print(f"pool_core {cfg.pool_core_address or 'UNSET'}")
    print(f"adapter   {cfg.adapter_address or 'UNSET'}")

    init_engine(cfg)
    async with get_sessionmaker()() as db:
        rows = (
            await db.execute(
                text("select account, last_lt, updated_at from indexer_cursors order by account")
            )
        ).all()
        print(f"\nindexer_cursors: {len(rows)} row(s)")
        for account, last_lt, updated in rows:
            watched = account in (cfg.pool_core_address, cfg.adapter_address)
            tag = "watched" if watched else "STALE"
            print(f"  {account}  last_lt={last_lt}  updated={updated}  [{tag}]")

        print()
        for t in TABLES:
            n = (await db.execute(text(f"select count(*) from {t}"))).scalar_one()
            print(f"  {t:22} {n}")


if __name__ == "__main__":
    asyncio.run(main())