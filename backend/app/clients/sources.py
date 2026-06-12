from typing import Protocol

from app.clients.chain import ChainClient
from app.clients.quote import AdapterState, LpQuote
from app.core.config import Settings, get_settings


class QuoteSource(Protocol):
    async def fetch(self) -> LpQuote: ...


class MockPoolQuoteSource:
    # testnet: the deployed mock STON.fi pool exposes (reserve, lp_supply) directly
    def __init__(self, client: ChainClient, pool_address: str):
        self.client = client
        self.pool = pool_address

    async def fetch(self) -> LpQuote:
        reserve, lp_supply = await self.client.run_get_method(self.pool, "get_lp_quote")
        return LpQuote(reserve=int(reserve), lp_supply=int(lp_supply))


async def read_adapter_state(client: ChainClient, adapter_address: str) -> AdapterState:
    # get_adapter_data -> (admin, principal, lp_balance, 5x addr, fee_bps)
    st = await client.run_get_method(adapter_address, "get_adapter_data")
    return AdapterState(principal=int(st[1]), lp_balance=int(st[2]), fee_bps=int(st[-1]))


def build_quote_source(client: ChainClient, cfg: Settings | None = None) -> QuoteSource:
    cfg = cfg or get_settings()
    if cfg.is_mainnet:
        # real STON.fi pool reserves are read at deploy time; wired in T1
        raise NotImplementedError("mainnet quote source is wired at deployment")
    if not cfg.stonfi_pool_address:
        raise RuntimeError("STONPOOL_STONFI_POOL_ADDRESS is not set")
    return MockPoolQuoteSource(client, cfg.stonfi_pool_address)
