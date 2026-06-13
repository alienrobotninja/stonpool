from typing import Any, Protocol

import httpx

from app.core.config import Settings, get_settings


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

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.cfg.toncenter_api_key:
            h["X-API-Key"] = self.cfg.toncenter_api_key
        return h

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.cfg.toncenter_base_url, timeout=15.0)
        return self._client

    async def run_get_method(self, address, method, stack=None):
        c = await self._http()
        r = await c.post(
            "/runGetMethod",
            json={"address": address, "method": method, "stack": stack or []},
            headers=self._headers(),
        )
        r.raise_for_status()
        data = r.json()
        if data.get("exit_code", 0) != 0:
            raise RuntimeError(f"get-method {method} on {address} exited {data.get('exit_code')}")
        return decode_stack(data.get("stack", []))

    async def get_transactions(self, address, *, after_lt=0, limit=50):
        c = await self._http()
        params: dict = {"account": address, "limit": limit, "sort": "asc"}
        if after_lt:
            params["start_lt"] = after_lt + 1
        r = await c.get("/transactions", params=params, headers=self._headers())
        r.raise_for_status()
        return r.json().get("transactions", [])

    async def send_boc(self, boc_b64: str) -> str:
        c = await self._http()
        r = await c.post("/message", json={"boc": boc_b64}, headers=self._headers())
        r.raise_for_status()
        return r.json().get("message_hash", "")

    async def aclose(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None
