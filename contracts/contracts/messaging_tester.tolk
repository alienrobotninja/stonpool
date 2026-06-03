import "shared"
import "messaging"

// op(32) jettonWallet:address destination:address responseDestination:address
fun onInternalMessage(in: InMessage) {
    var s = in.body;
    val op = s.loadUint(32);
    if (op != 0x1) { return; }
    val jettonWallet = s.loadAddress();
    val destination = s.loadAddress();
    val responseDestination = s.loadAddress();

    val transfer: JettonTransfer = {
        queryId: 1,
        amount: 100,
        destination: destination,
        responseDestination: responseDestination,
        customPayload: null,
        forwardTonAmount: 0,
        forwardPayload: null,
    };
    sendJettonTransfer(jettonWallet, 50000000, SEND_MODE_REGULAR, transfer);
}

get fun packJettonTransfer(destination: address, responseDestination: address): cell {
    val transfer: JettonTransfer = {
        queryId: 1, amount: 100, destination: destination,
        responseDestination: responseDestination, customPayload: null,
        forwardTonAmount: 0, forwardPayload: null,
    };
    return transfer.toCell();
}
