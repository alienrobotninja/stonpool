// Test-only fixture. Exposes get-methods that pack each shared struct so a
// sandbox test can assert the on-chain TL-B matches the off-chain wrappers.
// Not part of the production deploy set.
import "shared"

fun onInternalMessage(in: InMessage) {
    // no-op; this contract exists only for its get-methods
}

get fun packPoolConfig(): cell {
    val cfg: PoolConfig = {
        epochLength: 86400,
        depositCutoff: 3600,
        commitWindow: 300,
        revealWindow: 300,
        minHoldEpochs: 1,
        prizeTiers: 3,
        skimBps: 1500,
        drawBond: 1000000000,
    };
    return cfg.toCell();
}

get fun packDrawResult(): cell {
    val d: DrawResult = { epoch: 7, seed: 123456789 };
    return d.toCell();
}

get fun packAdapterReport(): cell {
    val r: AdapterReport = {
        reportedOp: OP_HARVEST_YIELD,
        principal: 5,
        yieldAmount: 2,
        success: true,
    };
    return r.toCell();
}

get fun packDepositPayload(addr: address): cell {
    val p: DepositPayload = { op: OP_DEPOSIT, beneficiary: addr };
    return p.toCell();
}

get fun unpackPoolConfig(c: cell): (uint32, uint32, uint32, uint32, uint16, uint8, uint16, coins) {
    val v = PoolConfig.fromCell(c);
    return (v.epochLength, v.depositCutoff, v.commitWindow, v.revealWindow, v.minHoldEpochs, v.prizeTiers, v.skimBps, v.drawBond);
}
get fun unpackDrawResult(c: cell): (uint32, uint256) {
    val v = DrawResult.fromCell(c);
    return (v.epoch, v.seed);
}
get fun unpackAdapterReport(c: cell): (uint32, coins, coins, bool) {
    val v = AdapterReport.fromCell(c);
    return (v.reportedOp, v.principal, v.yieldAmount, v.success);
}
get fun unpackDepositPayload(c: cell): (uint32, address) {
    val v = DepositPayload.fromCell(c);
    return (v.op, v.beneficiary);
}
