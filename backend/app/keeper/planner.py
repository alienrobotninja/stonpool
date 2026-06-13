from dataclasses import dataclass
from enum import Enum

from pytoniq_core import Cell

from app.clients.quote import AdapterState, LpQuote, harvest_plan
from app.core.config import Settings
from app.keeper.builders import (
    build_advance_epoch,
    build_commit,
    build_harvest_stonfi,
    build_reveal,
    build_settle_draw,
)

TON = 1_000_000_000
DRAW_BOND = TON  # matches the on-chain DRAW_BOND

VALUE_HARVEST = TON // 5
VALUE_ADVANCE = TON // 10
VALUE_COMMIT = DRAW_BOND + TON // 10
VALUE_REVEAL = TON // 10
VALUE_SETTLE = TON // 5


class Phase(str, Enum):
    ACCRUING = "accruing"  # epoch live, yield building, nothing to send
    HARVEST = "harvest"  # epoch ended, realize yield into the pot
    ADVANCE = "advance"  # roll the epoch
    COMMIT = "commit"  # post the bonded seed commitment
    REVEAL = "reveal"  # reveal the secret
    SETTLE = "settle"  # settle the draw and pay winners
    SETTLED = "settled"


@dataclass(frozen=True)
class KeeperState:
    phase: Phase
    epoch: int
    adapter: AdapterState
    quote: LpQuote
    commit_hash: int | None = None  # required at COMMIT
    reveal_secret: int | None = None  # required at REVEAL
    min_yield: int = 1  # dust floor below which a harvest is skipped


@dataclass(frozen=True)
class Action:
    kind: str  # harvest | advance | commit | reveal | settle
    to: str
    body: Cell
    value: int


def plan(state: KeeperState, cfg: Settings) -> list[Action]:
    # one phase -> at most one action; the executor owns phase transitions and the secret
    # lifecycle, so this stays pure and deterministic for a given state.
    p = state.phase
    if p is Phase.HARVEST:
        hp = harvest_plan(state.adapter, state.quote)
        if hp.gross_yield < state.min_yield:
            return []  # not worth a harvest tx; executor rolls straight to ADVANCE
        body = build_harvest_stonfi(
            lp_to_burn=hp.lp_to_burn, gross_yield=hp.gross_yield, to=cfg.vault_address
        )
        return [Action("harvest", cfg.adapter_address, body, VALUE_HARVEST)]
    if p is Phase.ADVANCE:
        return [Action("advance", cfg.pool_core_address, build_advance_epoch(), VALUE_ADVANCE)]
    if p is Phase.COMMIT:
        if state.commit_hash is None:
            raise ValueError("COMMIT phase requires commit_hash")
        return [
            Action("commit", cfg.draw_engine_address, build_commit(state.commit_hash), VALUE_COMMIT)
        ]
    if p is Phase.REVEAL:
        if state.reveal_secret is None:
            raise ValueError("REVEAL phase requires reveal_secret")
        return [
            Action(
                "reveal", cfg.draw_engine_address, build_reveal(state.reveal_secret), VALUE_REVEAL
            )
        ]
    if p is Phase.SETTLE:
        return [Action("settle", cfg.draw_engine_address, build_settle_draw(), VALUE_SETTLE)]
    return []  # ACCRUING, SETTLED
