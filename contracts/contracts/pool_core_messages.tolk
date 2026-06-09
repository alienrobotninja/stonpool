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
