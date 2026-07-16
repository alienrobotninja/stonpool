// C4 jetton-vault message surface.
import "shared"

// pool-core -> vault: pay `amount` of prize jetton to `to`.
struct (0x10000005) Payout {
    queryId: uint64
    to: address
    amount: coins
}

// vault -> pool-core: `amount` of prize jetton just landed in the pot.
//
// This is what makes prizePot true. The adapter's harvest report carries netYield, which
// is derived from a keeper-supplied grossYield - an off-chain estimate of a trade that
// STON.fi has not executed yet. The vault instead reports what actually arrived. Crediting
// pool-core from the estimate and the vault from the settlement guaranteed the two would
// disagree; crediting both from this one event means they cannot.
//
// A delta, not an absolute balance: an absolute figure races an in-flight Payout, since
// the vault would report a balance the payout has not been deducted from yet. Deltas
// commute, so both ledgers land on the same number whatever the ordering.
struct (0x10000006) VaultCredit {
    queryId: uint64
    amount: coins
}

// admin -> vault: wire the pool-core authority and the vault's own jetton wallet
// (derivable only after deploy, hence configured rather than deploy-time).
struct (0x10000072) ConfigureVault {
    queryId: uint64
    poolCore: address
    jettonWallet: address
}
