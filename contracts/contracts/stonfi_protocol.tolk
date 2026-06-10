// STON.fi v2 protocol surface (production). The canonical provide_lp forward
// payload C6 packs into a jetton transfer to the router's token wallet; redemption
// uses the standard TEP-74 jetton burn of LP tokens, so no extra struct is needed
// for that leg. Shared by C6 and the mock router so they agree on the wire.
// Simplified from the full STON.fi cross-body (routing-only fields - refund/excesses
// addresses, deadline, custom payload - are omitted) but opcode-faithful at
// 0x37c096df. Single-sided provide sets bothPositive = false.
import "shared"

const OP_STONFI_PROVIDE_LP = 0x37c096df;

struct ProvideLpForward {
    op: uint32
    minLpOut: coins
    toAddress: address
    bothPositive: bool
}
