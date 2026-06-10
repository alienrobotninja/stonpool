// Mock STON.fi v2 message surface. Test infrastructure: a faithful-at-the-wire
// stand-in for the real Router/Pool/LpAccount, which are external FunC and cannot
// run in the sandbox. We model the documented opcodes (provide_lp 0x37c096df, the
// jetton transfer_notification carrying a DEX forward payload, and the LP mint that
// comes back) so C6 can be tested against this as an oracle. Internals the adapter
// never observes (LpAccount accumulation, dual-token reserves, deadline/refund
// routing) are collapsed into a single-asset reserve model in the pool.
import "shared"

// Documented STON.fi op. The user/adapter sends underlying jettons to the router's
// jetton wallet with this op leading the forward payload; the router then forwards
// provide_lp to the pool.
const OP_STONFI_PROVIDE_LP = 0x37c096df;

// Configure ops for the stub (test-range, deliberately outside the shared ABI).
const OP_CFG_STONFI_ROUTER = 0x7e571001;
const OP_CFG_STONFI_POOL = 0x7e571002;

// Stub-local errors.
const ERR_STONFI_NOT_CONFIGURED = 810;
const ERR_STONFI_SLIPPAGE = 811;

// Forward payload C6 packs into the jetton transfer and the router reads back out
// of transfer_notification. Single-sided provide sets bothPositive = false; the
// pool auto-swaps and mints whatever LP the deposit is worth.
struct ProvideLpForward {
    op: uint32
    minLpOut: coins
    toAddress: address
    bothPositive: bool
}

// Router -> pool. Mirrors provide_lp#37c096df; the cross-body fields the adapter
// cares about (to_address, min_lp_out, both_positive) are carried, the routing-only
// fields are dropped since the stub holds the underlying in the router vault.
struct (0x37c096df) ProvideLp {
    queryId: uint64
    amount: coins
    toAddress: address
    minLpOut: coins
    bothPositive: bool
}

// LP mint wire, byte-compatible with the mock-jetton minter (MintNewJettons
// 0x00000015 -> InternalTransferStep 0x178d4519). Redefined here to keep the stub
// self-contained rather than importing across the mock-jetton package. The internal
// body ends after forwardTon; the wallet reads its forwardPayload as an empty
// remainder, and a zero forwardTon means no owner notification on mint.
struct (0x178d4519) LpMintInternal {
    queryId: uint64
    amount: coins
    initiator: address?
    excessesTo: address?
    forwardTon: coins
}

struct (0x00000015) MintLp {
    queryId: uint64
    recipient: address
    tonAmount: coins
    body: Cell<LpMintInternal>
}
