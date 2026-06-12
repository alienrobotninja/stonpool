// C8 param-governor message surface. PoolConfig packs inline in the bodies.
import "shared"

// admin -> governor: stage a new config behind the timelock.
struct (0x10000041) ProposeParams {
    queryId: uint64
    config: PoolConfig
}

// admin -> governor: apply the staged config once the timelock elapses.
struct (0x10000042) ExecuteParams {
    queryId: uint64
}

// governor -> pool-core: the new active config.
struct (0x10000043) ParamsUpdated {
    queryId: uint64
    config: PoolConfig
}
