import "shared"
import "messaging"

// op(32) selects behavior: 0x1 -> jetton transfer, 0x2 -> excesses
fun onInternalMessage(in: InMessage) {
    var s = in.body;
    val op = s.loadUint(32);

    if (op == 0x1) {
        val jettonWallet = s.loadAddress();
        val destination = s.loadAddress();
        val responseDestination = s.loadAddress();
        val transfer: JettonTransfer = {
            queryId: 1, amount: 100, destination: destination,
            responseDestination: responseDestination, customPayload: null,
            forwardTonAmount: 0, forwardPayload: null,
        };
        sendJettonTransfer(jettonWallet, 50000000, SEND_MODE_REGULAR, transfer);
        return;
    }

    if (op == 0x2) {
        val to = s.loadAddress();
        sendExcesses(to, 7, SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        return;
    }
}

get fun packJettonTransfer(destination: address, responseDestination: address): cell {
    val transfer: JettonTransfer = {
        queryId: 1, amount: 100, destination: destination,
        responseDestination: responseDestination, customPayload: null,
        forwardTonAmount: 0, forwardPayload: null,
    };
    return transfer.toCell();
}

get fun packJettonTransferFull(destination: address, responseDestination: address): cell {
    val transfer: JettonTransfer = {
        queryId: 1, amount: 100, destination: destination,
        responseDestination: responseDestination,
        customPayload: beginCell().storeUint(0xAB, 8).endCell(),
        forwardTonAmount: 5,
        forwardPayload: beginCell().storeUint(0xCD, 8).endCell(),
    };
    return transfer.toCell();
}

get fun unpackTransferNotification(c: cell): (uint64, coins, address, uint32) {
    val n = JettonTransferNotification.fromCell(c);
    // expose the leading op of the forward payload too
    var fp = n.forwardPayload;
    val fwdOp = fp.remainingBitsCount() >= 32 ? fp.loadUint(32) : 0;
    return (n.queryId, n.amount, n.sender, fwdOp as uint32);
}
