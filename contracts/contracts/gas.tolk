// gas: single source of truth for the settle -> finalize -> payout gas budget.
// Imported by pool-core and draw-engine so the two halves of the chain cannot drift.
//
// The bug this file exists to prevent: SETTLE_GAS lived in pool_core and
// DRAW_RESULT_GAS lived in draw_engine, authored independently. Two invariants were
// silently violated:
//
//   1. DRAW_RESULT_GAS (0.5) could not fund pool-core's payout loop. Those Payout
//      sends are SEND_MODE_REGULAR, so they deduct from the incoming message value.
//      The loop ran dry mid-distribution and the action phase aborted, while the
//      compute phase had already marked the draw finalized: a "finalized" draw that
//      paid only some winners.
//
//   2. SETTLE_GAS (0.2) was far below DRAW_RESULT_GAS. draw-engine forwards
//      DrawResultMsg with SEND_MODE_PAY_FEES_SEPARATELY, which takes the message
//      value from its OWN balance. Pool-core only topped it up by SETTLE_GAS, so
//      draw-engine subsidized the shortfall on every settle and slowly drained.
//      Bring-up needed a manual 2 TON top-up to finalize a draw.
//
// The invariants, now structural:
//
//   DRAW_RESULT_GAS >= PAYOUT_GAS * (MAX_PRIZE_TIERS + 1) + PAYOUT_LOOP_OVERHEAD
//   SETTLE_GAS      >= DRAW_RESULT_GAS + FINALIZE_OVERHEAD
//
// tests/pool_core_payout.spec.ts reads these back via get_gas_budget and sweeps the
// tier range, so lowering any of them fails the suite.

// value attached to each Payout message pool-core sends to the vault
const PAYOUT_GAS = ton("0.1");

// largest prizeTiers the budget is sized for. PoolConfig.prizeTiers is governor-
// settable and clamped at runtime to the eligible depositor count; if it is ever
// raised above this, DRAW_RESULT_GAS under-funds the loop again. The payout spec
// sweeps tiers up to this value.
const MAX_PRIZE_TIERS = 8;

// compute + storage headroom for the payout loop itself: ledger iteration,
// selectWinnerEx per tier, and the storage write, on top of the sends it makes
const PAYOUT_LOOP_OVERHEAD = ton("0.15");

// forwarded by draw-engine on DrawResultMsg. Must fund pool-core's entire payout
// loop: one Payout per tier plus one for the admin skim, plus loop overhead.
const DRAW_RESULT_GAS = PAYOUT_GAS * (MAX_PRIZE_TIERS + 1) + PAYOUT_LOOP_OVERHEAD;

// compute + storage headroom for draw-engine's finalize: commit-map iteration to
// tally reveals and slashed bonds, plus the storage write
const FINALIZE_OVERHEAD = ton("0.15");

// attached by pool-core on SettleDraw. Must cover draw-engine's finalize overhead
// AND the DrawResultMsg it forwards back, because that forward is
// SEND_MODE_PAY_FEES_SEPARATELY and would otherwise come out of draw-engine's own
// balance. Sized this way, draw-engine breaks even on every settle.
const SETTLE_GAS = DRAW_RESULT_GAS + FINALIZE_OVERHEAD;
