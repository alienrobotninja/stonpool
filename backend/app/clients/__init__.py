from app.clients.quote import (
    AdapterState,
    LpQuote,
    accrued_yield,
    harvest_plan,
    lp_value,
    net_of_fee,
)


def test_lp_value_and_zero_supply():
    assert lp_value(10_000, LpQuote(reserve=12_500, lp_supply=10_000)) == 12_500
    assert lp_value(10_000, LpQuote(reserve=0, lp_supply=0)) == 0


def test_accrued_yield_matches_e2e():
    st = AdapterState(principal=10_000, lp_balance=10_000)
    assert accrued_yield(st, LpQuote(12_500, 10_000)) == 2_500
    assert accrued_yield(st, LpQuote(10_000, 10_000)) == 0  # no growth, no yield


def test_harvest_plan_clean_e2e_vector():
    st = AdapterState(principal=10_000, lp_balance=10_000)
    plan = harvest_plan(st, LpQuote(12_500, 10_000))
    assert (plan.lp_to_burn, plan.gross_yield, plan.net_yield) == (2_000, 2_500, 2_500)


def test_harvest_plan_nets_fee():
    st = AdapterState(principal=10_000, lp_balance=10_000, fee_bps=100)  # 1%
    plan = harvest_plan(st, LpQuote(12_500, 10_000))
    assert plan.gross_yield == 2_500 and plan.net_yield == 2_475


def test_harvest_plan_floors():
    # reserve 11000 / lp 10000: raw yield 1000, lp_to_burn floors to 909, releasing 999
    st = AdapterState(principal=10_000, lp_balance=10_000)
    plan = harvest_plan(st, LpQuote(11_000, 10_000))
    assert plan.lp_to_burn == 909 and plan.gross_yield == 999


def test_harvest_plan_no_yield_is_noop():
    st = AdapterState(principal=10_000, lp_balance=10_000)
    plan = harvest_plan(st, LpQuote(10_000, 10_000))
    assert (plan.lp_to_burn, plan.gross_yield, plan.net_yield) == (0, 0, 0)


def test_net_of_fee_matches_s6():
    assert net_of_fee(250, 100) == 248
    assert net_of_fee(2_500, 100) == 2_475
    assert net_of_fee(2_500, 0) == 2_500
