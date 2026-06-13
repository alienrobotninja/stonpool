import base64
from dataclasses import dataclass

from pytoniq_core import Cell

OP_NOTIFICATION = 0x7362D09C
OP_DEPOSIT = 0x10000001
OP_REQUEST_WITHDRAW = 0x10000002
OP_HARVEST_STONFI = 0x10000035


@dataclass(frozen=True)
class DepositEvent:
    depositor: str
    amount: int


@dataclass(frozen=True)
class WithdrawEvent:
    depositor: str
    amount: int


@dataclass(frozen=True)
class HarvestEvent:
    gross_yield: int
    lp_to_burn: int


Event = DepositEvent | WithdrawEvent | HarvestEvent


def _addr(a) -> str | None:
    return a.to_str(is_user_friendly=False) if a is not None else None


def decode_in_message(body_b64: str | None, src: str | None) -> Event | None:
    if not body_b64:
        return None
    try:
        s = Cell.one_from_boc(base64.b64decode(body_b64)).begin_parse()
    except Exception:
        return None
    if s.remaining_bits < 32:
        return None
    op = s.load_uint(32)
    if op == OP_NOTIFICATION:
        return _deposit(s)
    if op == OP_REQUEST_WITHDRAW:
        return _withdraw(s, src)
    if op == OP_HARVEST_STONFI:
        return _harvest(s)
    return None


def _deposit(s) -> DepositEvent | None:
    s.load_uint(64)  # queryId
    amount = s.load_coins()
    s.load_address()  # notification sender
    # forwardPayload is inline; a deposit leads with OP_DEPOSIT then the depositor
    if s.remaining_bits < 32 or s.load_uint(32) != OP_DEPOSIT:
        return None
    depositor = _addr(s.load_address())
    if depositor is None:
        return None
    return DepositEvent(depositor=depositor, amount=amount)


def _withdraw(s, src: str | None) -> WithdrawEvent | None:
    s.load_uint(64)  # queryId
    amount = s.load_coins()
    if src is None:
        return None
    return WithdrawEvent(depositor=src, amount=amount)


def _harvest(s) -> HarvestEvent:
    s.load_uint(64)  # queryId
    lp = s.load_coins()
    gross = s.load_coins()
    return HarvestEvent(gross_yield=gross, lp_to_burn=lp)
