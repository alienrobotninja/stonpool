from typing import Protocol

from pytoniq_core import Cell


class TxSender(Protocol):
    # wraps `body` in a signed wallet external message to `to` carrying `value` nanotons,
    # broadcasts it, and returns an identifier. concrete impl lands in the executor step.
    async def send(self, *, to: str, body: Cell, value: int) -> str: ...


class RecordingSender:
    # test/dry-run sender: records calls instead of broadcasting
    def __init__(self):
        self.sent: list[dict] = []

    async def send(self, *, to: str, body: Cell, value: int) -> str:
        self.sent.append({"to": to, "body": body, "value": value})
        return f"fake-tx-{len(self.sent)}"
