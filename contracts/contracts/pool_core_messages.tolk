// C1 pool-core message surface (grows over the custody/core steps).
import "shared"

// admin -> pool-core: set one wiring slot (role -> contract address).
struct (0x10000073) ConfigureCore {
    queryId: uint64
    role: uint8
    addr: address
}

// depositor -> pool-core: withdraw `amount` of principal back to themselves.
struct (0x10000002) RequestWithdraw {
    queryId: uint64
    amount: coins
}

// admin/scheduler -> pool-core: close the epoch, harvest yield, open the draw.
struct (0x10000004) AdvanceEpoch {
    queryId: uint64
}

// scheduler -> pool-core: trigger the draw-engine to finalize (it is pool-core-gated).
struct (0x10000016) SettleDraw {
    queryId: uint64
}

// admin -> pool-core: force-clear the drawOpen guard.
//
// AdvanceEpoch arms drawOpen and only a DrawResultMsg clears it, so a StartDraw that
// never opened a draw would strand the flag and block every future advance. The
// StartDraw bounce handles that automatically, but TON guarantees nothing about bounce
// delivery: a bounce needs gas to fire, and bounces cannot themselves be bounced. This
// is the escape hatch that does not depend on that. Reachable only after a genuine
// StartDraw failure, which in practice means an unconfigured draw-engine.
struct (0x10000017) ClearDrawOpen {
    queryId: uint64
}