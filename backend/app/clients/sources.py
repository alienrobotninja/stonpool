import base64
from typing import Protocol

from pytoniq_core import Address, Cell, begin_cell

from app.clients.chain import ChainClient
from app.clients.quote import AdapterState, LpQuote, PoolData
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


async def read_pool_data(client: ChainClient, pool_address: str) -> PoolData:
    # get_pool_data -> (epoch, deposit_deadline, total_principal, prize_pot)
    st = await client.run_get_method(pool_address, "get_pool_data")
    return PoolData(
        epoch=int(st[0]),
        deposit_deadline=int(st[1]),
        total_principal=int(st[2]),
        prize_pot=int(st[3]),
    )


def _addr_arg(addr: str) -> dict:
    boc = begin_cell().store_address(Address(addr)).end_cell().to_boc()
    return {"type": "slice", "value": base64.b64encode(boc).decode()}


async def read_balance_of(client: ChainClient, pool_address: str, addr: str) -> tuple[int, int]:
    # get_balance_of(addr) -> (weight, join_epoch)
    st = await client.run_get_method(pool_address, "get_balance_of", [_addr_arg(addr)])
    return int(st[0]), int(st[1])


def _decode_addr_result(item) -> str:
    # an address get-method result arrives as a raw slice/cell stack item; nums are already
    # ints (decode_stack), so anything else here is the boc-wrapped address.
    if isinstance(item, str):
        return item
    boc = base64.b64decode(item["value"])
    return Cell.one_from_boc(boc).begin_parse().load_address().to_str(is_user_friendly=False)


async def read_preview_winner(client: ChainClient, pool_address: str, word: int) -> str:
    st = await client.run_get_method(
        pool_address, "preview_winner", [{"type": "num", "value": hex(word)}]
    )
    return _decode_addr_result(st[0])


def build_quote_source(client: ChainClient, cfg: Settings | None = None) -> QuoteSource:
    cfg = cfg or get_settings()
    if cfg.is_mainnet:
        # real STON.fi pool reserves are read at deploy time; wired in T1
        raise NotImplementedError("mainnet quote source is wired at deployment")
    if not cfg.stonfi_pool_address:
        raise RuntimeError("STONPOOL_STONFI_POOL_ADDRESS is not set")
    return MockPoolQuoteSource(client, cfg.stonfi_pool_address)
