import "shared"
import "mock_stonfi_messages"

fun onInternalMessage(in: InMessage) {}

get fun packProvideLpForward(to: address): cell {
    val m: ProvideLpForward = { op: OP_STONFI_PROVIDE_LP, minLpOut: 7, toAddress: to, bothPositive: false };
    return m.toCell();
}
get fun unpackProvideLpForward(c: cell): (uint32, coins, address, bool) {
    val v = ProvideLpForward.fromCell(c);
    return (v.op, v.minLpOut, v.toAddress, v.bothPositive);
}

get fun packProvideLp(to: address): cell {
    val m: ProvideLp = { queryId: 42, amount: 1000, toAddress: to, minLpOut: 7, bothPositive: false };
    return m.toCell();
}
get fun unpackProvideLp(c: cell): (uint64, coins, address, coins, bool) {
    val v = ProvideLp.fromCell(c);
    return (v.queryId, v.amount, v.toAddress, v.minLpOut, v.bothPositive);
}

get fun packLpMintInternal(): cell {
    val m: LpMintInternal = { queryId: 42, amount: 9, initiator: null, excessesTo: null, forwardTon: 0 };
    return m.toCell();
}

get fun packMintLp(to: address): cell {
    val it: LpMintInternal = { queryId: 42, amount: 9, initiator: null, excessesTo: null, forwardTon: 0 };
    val m: MintLp = { queryId: 42, recipient: to, tonAmount: ton("0.1"), body: it.toCell() };
    return m.toCell();
}
