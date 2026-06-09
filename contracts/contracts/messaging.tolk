// Messaging primitives shared by pool-core and the adapters. Internal sends use
// the stdlib createMessage/.send directly at call sites; the only project-level
// helpers worth centralizing are the TEP-74 jetton transfer and the gas-return
// excesses reply, since both recur and are easy to get subtly wrong.
import "shared"

// TEP-74 transfer body. custom_payload (Maybe ^Cell) and forward_payload
// (Either Cell ^Cell) both map to cell?: present serializes as 1 + ref, absent
// as a single 0 bit, which matches the wire format for the present/empty cases.
struct (0x0f8a7ea5) JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    responseDestination: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: cell?
}

// TEP-74 excesses (gas return).
struct (0xd53276db) JettonExcesses {
    queryId: uint64
}

// Incoming TEP-74 transfer notification (received by a vault/adapter from its
// jetton wallet). forwardPayload is the remainder; callers inspect its leading
// op to route the deposit.
struct (0x7362d09c) JettonTransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    forwardPayload: RemainingBitsAndRefs
}

// Move jetton out of this contract's wallet. bounce on so a failed transfer
// returns the value. tonValue must cover wallet gas plus forwardTonAmount.
fun sendJettonTransfer(jettonWallet: address, tonValue: coins, mode: int, transfer: JettonTransfer): void {
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: tonValue,
        dest: jettonWallet,
        body: transfer,
    }).send(mode);
}

// Return surplus gas to `to`. Pair with SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE.
fun sendExcesses(to: address, queryId: uint64, mode: int): void {
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: to,
        body: JettonExcesses { queryId },
    }).send(mode);
}

// TEP-74 transfer carrying an inline 32-bit op as the forward payload (raw
// remainder, not Maybe^Cell). The mock wallet forwards the remainder verbatim
// into its transfer_notification, so the recipient reads the tag from the
// leading 32 bits. forwardTonAmount must be > 0 or no notification is emitted.
struct (0x0f8a7ea5) JettonTransferTagged {
    queryId: uint64
    amount: coins
    destination: address
    responseDestination: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardOp: uint32
}

fun sendJettonTransferTagged(jettonWallet: address, tonValue: coins, mode: int, transfer: JettonTransferTagged): void {
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: tonValue,
        dest: jettonWallet,
        body: transfer,
    }).send(mode);
}
