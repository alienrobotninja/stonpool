import asyncio
import random
import time
from typing import Any, Protocol

import httpx

from app.core.config import Settings, get_settings

RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


class ChainClient(Protocol):
    async def run_get_method(
        self, address: str, method: str, stack: list[Any] | None = None
    ) -> list[Any]: ...

    async def get_transactions(
        self, address: str, *, after_lt: int = 0, limit: int = 50
    ) -> list[dict]: ...


def decode_stack(items: list[dict]) -> list[Any]:
    # toncenter v3 returns each stack entry as {"type": ..., "value": ...}; nums arrive
    # as hex strings. cells/slices are kept raw so callers index only the nums they need.
    out: list[Any] = []
    for it in items:
        t = it.get("type")
        v = it.get("value")
        if t in ("num", "int"):
            out.append(int(v, 16) if isinstance(v, str) and v.startswith("0x") else int(v))
        else:
            out.append(it)
    return out


class ToncenterClient:
    def __init__(self, cfg: Settings | None = None, client: httpx.AsyncClient | None = None):
        self.cfg = cfg or get_settings()
        self._client = client
        self._gate = asyncio.Lock()
        self._last = 0.0

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.cfg.toncenter_api_key:
            h["X-API-Key"] = self.cfg.toncenter_api_key
        return h

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.cfg.toncenter_base_url, timeout=15.0)
        return self._client

    async def _pace(self) -> None:
        # toncenter caps requests per second. one derive pass fires a get-method per
        # depositor back to back, which outruns the cap partway through and costs the whole
        # pass, so hold a floor between calls instead of discovering the limit by hitting it
        async with self._gate:
            wait = self._last + self.cfg.toncenter_min_interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()

    async def _request(self, method: str, url: str, retry: bool = True, **kw) -> httpx.Response:
        tries = self.cfg.toncenter_max_retries if retry else 0
        for attempt in range(tries + 1):
            await self._pace()
            c = await self._http()
            r = await c.request(method, url, headers=self._headers(), **kw)
            if r.status_code not in RETRY_STATUS or attempt == tries:
                r.raise_for_status()
                return r
            # honour Retry-After when toncenter sends one; jitter the fallback so the
            # indexer and the deriver do not line back up on the same second
            after = r.headers.get("retry-after")
            delay = float(after) if after else 0.5 * 2**attempt
            await asyncio.sleep(delay + random.uniform(0, 0.1))
        raise AssertionError("unreachable")

    async def run_get_method(self, address, method, stack=None):
        r = await self._request(
            "POST",
            "/runGetMethod",
            json={"address": address, "method": method, "stack": stack or []},
        )
        data = r.json()
        if data.get("exit_code", 0) != 0:
            raise RuntimeError(f"get-method {method} on {address} exited {data.get('exit_code')}")
        return decode_stack(data.get("stack", []))

    async def get_transactions(self, address, *, after_lt=0, limit=50):
        params: dict = {"account": address, "limit": limit, "sort": "asc"}
        if after_lt:
            params["start_lt"] = after_lt + 1
        r = await self._request("GET", "/transactions", params=params)
        return r.json().get("transactions", [])

    async def send_boc(self, boc_b64: str) -> str:
        # no retry: a 5xx can still have landed the message, and resending risks a second
        # broadcast of the same external
        r = await self._request("POST", "/message", retry=False, json={"boc": boc_b64})
        return r.json().get("message_hash", "")

    async def aclose(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None