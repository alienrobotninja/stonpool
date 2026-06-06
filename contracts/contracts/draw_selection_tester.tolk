// Test-only fixture: packs/unpacks the C2/C3 structs so a sandbox test can pin
// the on-chain TL-B against the off-chain wrappers. Not in the deploy set.
import "shared"
import "selection"
import "draw_messages"

fun onInternalMessage(in: InMessage) {
    // no-op; this contract exists only for its get-methods
}

get fun packLedgerEntry(): cell {
    val e: LedgerEntry = { weight: 5000, joinEpoch: 4 };
    return e.toCell();
}
get fun packSelectWinners(): cell {
    val m: SelectWinners = { queryId: 9, seed: 0xABCDEF, tierCount: 3 };
    return m.toCell();
}
get fun packWinnersResult(): cell {
    val m: WinnersResult = { queryId: 9, epoch: 7, seed: 0xABCDEF, tierCount: 3 };
    return m.toCell();
}
get fun packStartDraw(): cell {
    val m: StartDraw = { queryId: 1, epoch: 7 };
    return m.toCell();
}
get fun packFinalizeDraw(): cell {
    val m: FinalizeDraw = { queryId: 1 };
    return m.toCell();
}
get fun packCommit(): cell {
    val m: Commit = { queryId: 1, commitHash: 0x1111 };
    return m.toCell();
}
get fun packReveal(): cell {
    val m: Reveal = { queryId: 1, secret: 0x2222 };
    return m.toCell();
}
get fun packDrawResultMsg(): cell {
    val r: DrawResult = { epoch: 7, seed: 123456789 };
    val m: DrawResultMsg = { queryId: 1, result: r };
    return m.toCell();
}

get fun unpackLedgerEntry(c: cell): (coins, uint32) {
    val v = LedgerEntry.fromCell(c);
    return (v.weight, v.joinEpoch);
}
get fun unpackSelectWinners(c: cell): (uint64, uint256, uint16) {
    val v = SelectWinners.fromCell(c);
    return (v.queryId, v.seed, v.tierCount);
}
get fun unpackWinnersResult(c: cell): (uint64, uint32, uint256, uint16) {
    val v = WinnersResult.fromCell(c);
    return (v.queryId, v.epoch, v.seed, v.tierCount);
}
get fun unpackStartDraw(c: cell): (uint64, uint32) {
    val v = StartDraw.fromCell(c);
    return (v.queryId, v.epoch);
}
get fun unpackFinalizeDraw(c: cell): uint64 {
    val v = FinalizeDraw.fromCell(c);
    return v.queryId;
}
get fun unpackCommit(c: cell): (uint64, uint256) {
    val v = Commit.fromCell(c);
    return (v.queryId, v.commitHash);
}
get fun unpackReveal(c: cell): (uint64, uint256) {
    val v = Reveal.fromCell(c);
    return (v.queryId, v.secret);
}
get fun unpackDrawResultMsg(c: cell): (uint64, uint32, uint256) {
    val v = DrawResultMsg.fromCell(c);
    return (v.queryId, v.result.epoch, v.result.seed);
}
