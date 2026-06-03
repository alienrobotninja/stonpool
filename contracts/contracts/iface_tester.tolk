import "shared"
import "yield_adapter_iface"

fun onInternalMessage(in: InMessage) {}

get fun packDepositPrincipal(): cell {
    val m: DepositPrincipal = { queryId: 42 };
    return m.toCell();
}
get fun packWithdrawPrincipal(to: address): cell {
    val m: WithdrawPrincipal = { queryId: 42, amount: 7, to: to };
    return m.toCell();
}
get fun packHarvestYield(to: address): cell {
    val m: HarvestYield = { queryId: 42, to: to };
    return m.toCell();
}
get fun packAdapterReportMsg(): cell {
    val r: AdapterReport = { reportedOp: OP_HARVEST_YIELD, principal: 5, yieldAmount: 2, success: true };
    val m: AdapterReportMsg = { queryId: 42, report: r };
    return m.toCell();
}

get fun unpackDepositPrincipal(c: cell): uint64 {
    return DepositPrincipal.fromCell(c).queryId;
}
get fun unpackWithdrawPrincipal(c: cell): (uint64, coins, address) {
    val v = WithdrawPrincipal.fromCell(c);
    return (v.queryId, v.amount, v.to);
}
get fun unpackHarvestYield(c: cell): (uint64, address) {
    val v = HarvestYield.fromCell(c);
    return (v.queryId, v.to);
}
get fun unpackAdapterReportMsg(c: cell): (uint64, uint32, coins, coins, bool) {
    val v = AdapterReportMsg.fromCell(c);
    return (v.queryId, v.report.reportedOp, v.report.principal, v.report.yieldAmount, v.report.success);
}
