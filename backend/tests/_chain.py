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


def config_cell(
    *,
    epoch_length=3600,
    deposit_cutoff=600,
    commit_window=900,
    reveal_window=900,
    min_hold_epochs=1,
    prize_tiers=3,
    skim_bps=1000,
    draw_bond=1_000_000_000,
):
    # mirrors packConfig in contracts/wrappers/protocol.ts; pool-core's get_config returns
    # exactly this cell, so parsing it here exercises the real layout
    return {
        "type": "cell",
        "value": _boc(
            begin_cell()
            .store_uint(epoch_length, 32)
            .store_uint(deposit_cutoff, 32)
            .store_uint(commit_window, 32)
            .store_uint(reveal_window, 32)
            .store_uint(min_hold_epochs, 16)
            .store_uint(prize_tiers, 8)
            .store_uint(skim_bps, 16)
            .store_coins(draw_bond)
            .end_cell()
        ),
    }


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
        self,
        methods: dict[str, list],
        balances: dict[str, tuple[int, int]] | None = None,
        preview_winners: list[str] | None = None,
        wallet_address: str | None = None,
    ):
        self.methods = methods
        self.balances = balances or {}
        self._winners = list(preview_winners or [])
        self.wallet_address = wallet_address

    async def run_get_method(self, address, method, stack=None):
        if method == "get_balance_of":
            cell = Cell.one_from_boc(base64.b64decode(stack[0]["value"]))
            addr = cell.begin_parse().load_address().to_str(is_user_friendly=False)
            weight, join_epoch = self.balances[addr]
            return [weight, join_epoch]
        if method == "preview_winner":
            return [self._winners.pop(0)]
        if method == "get_wallet_address":
            boc = begin_cell().store_address(Address(self.wallet_address)).end_cell().to_boc()
            return [{"type": "slice", "value": base64.b64encode(boc).decode()}]
        return self.methods[method]

    async def get_transactions(self, address, *, after_lt=0, limit=50):
        return []