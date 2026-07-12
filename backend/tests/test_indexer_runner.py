from app.core.config import Settings
from app.indexer.runner import scan_once, watched_accounts
from tests._chain import A1, FakeChainClient, deposit_body, harvest_body, tx

POOL = "0:" + "aa" * 32
ADAPTER = "0:" + "bb" * 32


def _cfg(**kw) -> Settings:
    return Settings(_env_file=None, **kw)


def test_watched_accounts_skips_unset():
    assert watched_accounts(_cfg()) == []
    assert watched_accounts(_cfg(pool_core_address=POOL)) == [POOL]
    assert watched_accounts(_cfg(pool_core_address=POOL, adapter_address=ADAPTER)) == [
        POOL,
        ADAPTER,
    ]


async def test_scan_once_covers_all_accounts_and_commits(sm):
    fake = FakeChainClient(
        {
            POOL: [tx("d1", 10, 100, deposit_body(1000, A1), src=POOL)],
            ADAPTER: [tx("h1", 20, 200, harvest_body(500, 5), src=ADAPTER)],
        }
    )
    cfg = _cfg(pool_core_address=POOL, adapter_address=ADAPTER, skim_bps=1000)

    res = await scan_once(fake, cfg, session_factory=sm)
    assert res[POOL].deposits == 1
    assert res[ADAPTER].harvests == 1

    # cursor persisted: a second pass re-fetches nothing
    res2 = await scan_once(fake, cfg, session_factory=sm)
    assert (res2[POOL].scanned, res2[ADAPTER].scanned) == (0, 0)
