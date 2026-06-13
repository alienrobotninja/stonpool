from pytoniq_core import begin_cell

from app.indexer.decode import DepositEvent, HarvestEvent, WithdrawEvent, decode_in_message
from tests._chain import A1, A2, _boc, deposit_body, harvest_body, withdraw_body


def test_decode_deposit():
    ev = decode_in_message(deposit_body(1000, A1), src=A2)
    assert isinstance(ev, DepositEvent) and ev.amount == 1000 and ev.depositor == A1


def test_decode_withdraw_uses_tx_source():
    ev = decode_in_message(withdraw_body(400), src=A1)
    assert isinstance(ev, WithdrawEvent) and ev.amount == 400 and ev.depositor == A1


def test_decode_harvest():
    ev = decode_in_message(harvest_body(2000, 2500), src=A2)
    assert isinstance(ev, HarvestEvent) and ev.gross_yield == 2500 and ev.lp_to_burn == 2000


def test_notification_without_deposit_tag_is_ignored():
    assert decode_in_message(deposit_body(1000, A1, fwd_op=0xDEADBEEF), src=A2) is None


def test_unknown_op_and_empty_body():
    other = _boc(begin_cell().store_uint(0xDEADBEEF, 32).end_cell())
    assert decode_in_message(other, src=A2) is None
    assert decode_in_message(None, src=A2) is None
    assert decode_in_message("", src=A2) is None
