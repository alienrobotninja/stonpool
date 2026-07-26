import argparse
import asyncio

from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.db.session import _engine_kwargs, get_sessionmaker, init_engine

# every table the indexer and the deriver own. alembic_version is deliberately absent:
# dropping it would make the next release command replay the whole migration history
TABLES = [
    "deposits",
    "withdrawals",
    "harvests",
    "payouts",
    "depositor_positions",
    "pool_snapshots",
    "epochs",
    "draws",
    "indexer_cursors",
]


async def counts(db) -> dict[str, int]:
    return {t: (await db.execute(text(f"select count(*) from {t}"))).scalar_one() for t in TABLES}


def show(label, rows):
    print(label)
    for t, n in rows.items():
        print(f"  {t:22} {n}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="required; without it nothing is deleted")
    args = ap.parse_args()

    cfg = get_settings()
    url, _ = _engine_kwargs(cfg)
    backend = make_url(url).get_backend_name()
    print(f"url     {make_url(url).render_as_string(hide_password=True)}")

    init_engine(cfg)
    async with get_sessionmaker()() as db:
        before = await counts(db)
        show("\nbefore", before)
        if not sum(before.values()):
            print("\nnothing to purge")
            return
        if not args.yes:
            print("\ndry run. re-run with --yes to delete the rows above")
            return

        if backend == "postgresql":
            # one statement, so mutual foreign keys cannot dictate a delete order
            await db.execute(text(f"truncate {', '.join(TABLES)} restart identity cascade"))
        else:
            for t in reversed(TABLES):
                await db.execute(text(f"delete from {t}"))

        # count before the commit: if these are zero the delete itself worked, and any
        # rows present afterwards were written back by a live indexer or deriver
        emptied = await counts(db)
        await db.commit()

        after = await counts(db)
        show("\nafter", after)
        if any(emptied.values()):
            raise SystemExit("delete failed; rows survived the statement")
        if any(after.values()):
            raise SystemExit(
                "deleted, then refilled: the api is still writing. stop the machine, or "
                "point it at the new deployment first"
            )
        print("\npurged")


if __name__ == "__main__":
    asyncio.run(main())