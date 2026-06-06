// C1 pool-core message surface (grows over the custody/core steps).
import "shared"

// admin -> pool-core: set one wiring slot (role -> contract address).
struct (0x10000073) ConfigureCore {
    queryId: uint64
    role: uint8
    addr: address
}
