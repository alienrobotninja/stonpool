import base64

from pytoniq_core import Address, Cell, begin_cell

A1 = "0:" + "cd" * 32
A2 = "0:" + "11" * 32


def _boc(cell) -> str:
    return base64.b64encode(cell.to_boc()).decode()


def deposit_body(amount, depositor, fwd_op=0x10000001, sender=A2):
    return _boc(
        begin_cell()
        .store_uint(0x7362D09C, 32)
        .store_uint(0, 64)
        .store_coins(amount)
        .store_address(Address(sender))
        .store_uint(fwd_op, 32)
        .store_address(Address(depositor))
        .end_cell()
    )


def withdraw_body(amount):
    return _boc(
        begin_cell().store_uint(0x10000002, 32).store_uint(0, 64).store_coins(amount).end_cell()
    )


def harvest_body(lp, gross, to=A2):
    return _boc(
        begin_cell()
        .store_uint(0x10000035, 32)
        .store_uint(0, 64)
        .store_coins(lp)
        .store_coins(gross)
        .store_address(Address(to))
        .end_cell()
    )


def tx(h, lt, now, body, src=None):
    return {
        "hash": h,
        "lt": lt,
        "now": now,
        "in_msg": {"source": src, "message_content": {"body": body}},
    }


class FakeChainClient:
    def __init__(self, by_account: dict[str, list[dict]]):
        self.by_account = by_account

    async def run_get_method(self, address, method, stack=None):
        return []

    async def get_transactions(self, address, *, after_lt=0, limit=50):
        return [t for t in self.by_account.get(address, []) if int(t["lt"]) > after_lt]


class FakeGetMethodClient:
    # methods: no-arg get-methods -> decoded stack list.
    # balances: depositor raw address -> (weight, join_epoch); the address arg is decoded
    # from the stack slice, exercising the real arg encoding.
    def __init__(
        self, methods: dict[str, list], balances: dict[str, tuple[int, int]] | None = None
    ):
        self.methods = methods
        self.balances = balances or {}

    async def run_get_method(self, address, method, stack=None):
        if method == "get_balance_of":
            cell = Cell.one_from_boc(base64.b64decode(stack[0]["value"]))
            addr = cell.begin_parse().load_address().to_str(is_user_friendly=False)
            weight, join_epoch = self.balances[addr]
            return [weight, join_epoch]
        return self.methods[method]

    async def get_transactions(self, address, *, after_lt=0, limit=50):
        return []
