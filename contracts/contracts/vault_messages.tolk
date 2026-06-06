// C4 jetton-vault message surface.
import "shared"

// pool-core -> vault: pay `amount` of prize jetton to `to`.
struct (0x10000005) Payout {
    queryId: uint64
    to: address
    amount: coins
}

// admin -> vault: wire the pool-core authority and the vault's own jetton wallet
// (derivable only after deploy, hence configured rather than deploy-time).
struct (0x10000072) ConfigureVault {
    queryId: uint64
    poolCore: address
    jettonWallet: address
}
