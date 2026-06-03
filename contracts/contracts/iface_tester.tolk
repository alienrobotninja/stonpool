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
