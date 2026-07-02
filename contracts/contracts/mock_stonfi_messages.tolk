// Mock STON.fi v2 message surface. Test infrastructure: a faithful-at-the-wire
// stand-in for the real Router/Pool/LpAccount/LpWallet, which are external FunC
// and cannot run in the sandbox. We model the documented flow so C6 can be tested
// against it as an oracle: provide_lp (0x37c096df) in, LP jettons minted back, and
// LP burned out releases the underlying via the router vault (the real pay_to path).
// The pool is the LP jetton master, so an LP burn notifies the pool directly, the
// way STON.fi v2 wires it. Internals the adapter never observes (LpAccount
// accumulation, dual-token reserves, deadline/refund routing) collapse into a
// single-asset reserve model; yield is modeled by growing reserve, not lpSupply.
import "shared"

// Stub ops (test-range, deliberately outside the shared ABI).
const OP_CFG_STONFI_ROUTER = 0x7e571001;
const OP_CFG_STONFI_POOL = 0x7e571002;
const OP_STONFI_PAYOUT = 0x7e571003;
const OP_STONFI_ACCRUE = 0x7e571004;
const OP_STONFI_SIMULATE_LOSS = 0x7e571005;

// Standard jetton burn notification op (mock-jetton wallet -> its master).
const OP_BURN_NOTIFICATION = 0x7bdd97de;

// Stub-local errors.
const ERR_STONFI_NOT_CONFIGURED = 810;
const ERR_STONFI_SLIPPAGE = 811;
const ERR_STONFI_INSUFFICIENT_LP = 812;

// Router -> pool. Mirrors provide_lp#37c096df, carrying the cross-body fields the
// adapter sets; routing-only fields are dropped since the stub holds the underlying
// in the router vault.
struct (0x37c096df) ProvideLp {
    queryId: uint64
    amount: coins
    toAddress: address
    minLpOut: coins
    bothPositive: bool
}

// internal_transfer body the pool sends to deploy/credit an LP wallet. Ends after
// forwardTon; the wallet reads its forwardPayload as an empty remainder, and a zero
// forwardTon means no owner notification on mint. Byte-compatible with the
// mock-jetton wallet's InternalTransferStep (0x178d4519).
struct (0x178d4519) LpMintInternal {
    queryId: uint64
    amount: coins
    initiator: address?
    excessesTo: address?
    forwardTon: coins
}

// Burn notification the LP wallet sends to its master (the pool) on burn.
// Byte-compatible with the mock-jetton wallet's BurnNotificationForMinter.
struct (0x7bdd97de) LpBurnNotification {
    queryId: uint64
    jettonAmount: coins
    burnInitiator: address
    sendExcessesTo: address?
}

// pool -> router: release `amount` underlying from the vault to `to` (the real
// pay_to leg). Router-gated to the pool.
struct (0x7e571003) PayOut {
    queryId: uint64
    to: address
    amount: coins
}

// admin -> pool: grow reserve to model accrued swap fees. lpSupply is untouched, so
// each LP token redeems for more underlying afterward.
struct (0x7e571004) AccrueYield {
    queryId: uint64
    amount: coins
}

// admin -> pool: shrink reserve to model a depeg/impermanent loss. lpSupply is
// untouched, so each LP token redeems for less underlying afterward; the shortfall is
// borne proportionally by all LP holders (test infra only).
struct (0x7e571005) SimulateLoss {
    queryId: uint64
    amount: coins
}

// LP wallet address calc. WalletStorage layout mirrors the mock-jetton wallet
// ({jettonBalance, ownerAddress, minterAddress}) so the addresses the pool computes
// match the real wallets the mock jetton deploys. Kept local to avoid importing
// across the mock-jetton package.
struct LpWalletStorage {
    jettonBalance: coins
    ownerAddress: address
    minterAddress: address
}

fun lpDeployTarget(owner: address, master: address, walletCode: cell): AutoDeployAddress {
    val s: LpWalletStorage = { jettonBalance: 0, ownerAddress: owner, minterAddress: master };
    return { stateInit: { code: walletCode, data: s.toCell() } };
}

fun lpWalletAddress(owner: address, master: address, walletCode: cell) {
    return lpDeployTarget(owner, master, walletCode).calculateAddress();
}
