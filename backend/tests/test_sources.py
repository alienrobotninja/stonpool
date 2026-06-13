import pytest

from app.clients.chain import decode_stack
from app.clients.quote import harvest_plan
from app.clients.sources import MockPoolQuoteSource, build_quote_source, read_adapter_state
from app.core.config import Settings


class FakeChainClient:
    def __init__(self, methods: dict[str, list]):
        self.methods = methods
        self.calls: list[tuple[str, str]] = []

    async def run_get_method(self, address, method, stack=None):
        self.calls.append((address, method))
        return self.methods[method]

    async def get_transactions(self, address, *, after_lt=0, limit=50):
        return []


def _addr_item():
    return {"type": "slice", "value": "te6cc..."}


def test_decode_stack_parses_hex_nums():
    items = [{"type": "num", "value": "0x30d4"}, {"type": "num", "value": "10000"}, _addr_item()]
    out = decode_stack(items)
    assert out[0] == 0x30D4 and out[1] == 10_000 and isinstance(out[2], dict)


async def test_mock_pool_quote_source():
    fake = FakeChainClient({"get_lp_quote": [12_500, 10_000]})
    q = await MockPoolQuoteSource(fake, "0:pool").fetch()
    assert q.reserve == 12_500 and q.lp_supply == 10_000
    assert fake.calls == [("0:pool", "get_lp_quote")]


async def test_read_adapter_state_picks_nums():
    stack = [_addr_item(), 10_000, 10_000, None, None, None, None, None, 100]
    fake = FakeChainClient({"get_adapter_data": stack})
    st = await read_adapter_state(fake, "0:adapter")
    assert st.principal == 10_000 and st.lp_balance == 10_000 and st.fee_bps == 100


async def test_end_to_end_plan_from_chain_reads():
    fake = FakeChainClient(
        {
            "get_lp_quote": [12_500, 10_000],
            "get_adapter_data": [_addr_item(), 10_000, 10_000, None, None, None, None, None, 100],
        }
    )
    q = await MockPoolQuoteSource(fake, "0:pool").fetch()
    st = await read_adapter_state(fake, "0:adapter")
    plan = harvest_plan(st, q)
    assert (plan.lp_to_burn, plan.gross_yield, plan.net_yield) == (2_000, 2_500, 2_475)


def test_build_quote_source_testnet_and_mainnet():
    fake = FakeChainClient({})
    src = build_quote_source(fake, Settings(env="testnet", stonfi_pool_address="0:pool"))
    assert isinstance(src, MockPoolQuoteSource)

    with pytest.raises(RuntimeError):
        build_quote_source(fake, Settings(env="testnet", stonfi_pool_address=""))
    with pytest.raises(NotImplementedError):
        build_quote_source(fake, Settings(env="mainnet"))
