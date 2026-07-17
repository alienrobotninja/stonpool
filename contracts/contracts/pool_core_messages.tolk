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

// anyone -> pool-core: undo a journaled withdrawal the adapter never answered.
//
// The journal's last branch. An ack clears the entry, a bounce restores from it, and
// this covers the case where neither arrives - a message lost, or an adapter wedged
// mid-flight. Without it the record would sit there forever and the depositor's claim
// with it, which is the one branch that would put a fund loss back into Option B.
//
// Deliberately permissionless: the restore credits the address in the journal, never
// the caller, so there is nothing to gain by calling it on someone else's behalf.
// Gating it on the admin would make recovery depend on a key being available at
// exactly the moment something has already gone wrong.
struct (0x10000018) ReclaimWithdraw {
    queryId: uint64
}