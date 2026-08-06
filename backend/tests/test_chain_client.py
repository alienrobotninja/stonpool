import time

import httpx
import pytest

from app.clients.chain import ToncenterClient
from app.core.config import Settings

ADDR = "0:" + "aa" * 32
OK_STACK = {"exit_code": 0, "stack": [{"type": "num", "value": "0x7"}]}


def _cfg(**kw) -> Settings:
    base = {"toncenter_min_interval": 0.0, "toncenter_max_retries": 3}
    base.update(kw)
    return Settings(_env_file=None, **base)


def _client(handler, **kw) -> ToncenterClient:
    cfg = _cfg(**kw)
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url=cfg.toncenter_base_url
    )
    return ToncenterClient(cfg, http)


async def test_a_rate_limited_call_is_retried_rather_than_lost():
    seen = []

    def handler(request):
        seen.append(request.url.path)
        if len(seen) == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        return httpx.Response(200, json=OK_STACK)

    c = _client(handler)
    assert await c.run_get_method(ADDR, "get_pool_data") == [7]
    assert len(seen) == 2
    await c.aclose()


async def test_calls_are_held_apart_by_the_configured_floor():
    def handler(request):
        return httpx.Response(200, json=OK_STACK)

    c = _client(handler, toncenter_min_interval=0.05)
    started = time.monotonic()
    for _ in range(3):
        await c.run_get_method(ADDR, "get_pool_data")
    assert time.monotonic() - started >= 0.1
    await c.aclose()


async def test_a_broadcast_is_never_resent():
    seen = []

    def handler(request):
        seen.append(request.url.path)
        return httpx.Response(500)

    c = _client(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await c.send_boc("te6")
    assert len(seen) == 1
    await c.aclose()