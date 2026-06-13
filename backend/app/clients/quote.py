from dataclasses import dataclass

BPS_DENOM = 10_000


@dataclass(frozen=True)
class LpQuote:
    reserve: int
    lp_supply: int


@dataclass(frozen=True)
class AdapterState:
    principal: int
    lp_balance: int
    fee_bps: int = 0


@dataclass(frozen=True)
class PoolData:
    epoch: int
    deposit_deadline: int
    total_principal: int
    prize_pot: int


@dataclass(frozen=True)
class HarvestPlan:
    lp_to_burn: int
    gross_yield: int  # underlying the burn actually releases (keeper sends this to C6)
    net_yield: int  # gross minus the disclosed fee; what funds the prize pot


def lp_value(lp_balance: int, q: LpQuote) -> int:
    if q.lp_supply == 0:
        return 0
    return lp_balance * q.reserve // q.lp_supply


def accrued_yield(state: AdapterState, q: LpQuote) -> int:
    return max(lp_value(state.lp_balance, q) - state.principal, 0)


def net_of_fee(gross: int, fee_bps: int) -> int:
    # mirrors C6: grossYield - grossYield*feeBps/BPS_DENOM
    return gross - gross * fee_bps // BPS_DENOM


def harvest_plan(state: AdapterState, q: LpQuote) -> HarvestPlan:
    raw = accrued_yield(state, q)
    if raw <= 0 or q.reserve == 0 or q.lp_supply == 0:
        return HarvestPlan(lp_to_burn=0, gross_yield=0, net_yield=0)
    # LP whose underlying equals the accrued yield, then recompute the real release for
    # that integer burn so the reported gross matches what physically moves to the vault
    lp_to_burn = min(raw * q.lp_supply // q.reserve, state.lp_balance)
    gross = lp_to_burn * q.reserve // q.lp_supply
    return HarvestPlan(
        lp_to_burn=lp_to_burn, gross_yield=gross, net_yield=net_of_fee(gross, state.fee_bps)
    )
