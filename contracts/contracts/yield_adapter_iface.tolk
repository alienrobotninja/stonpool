// C5 yield-adapter-iface: the message contract every yield adapter implements
// and pool-core codes against. Principal itself moves as a jetton transfer;
// these messages carry the intent and routing. Imported by pool-core, C6, C7.
//
// Tolk requires struct opcode prefixes to be literals, so the hex below mirrors
// the OP_* consts in shared.tolk. The TL-B test pins each value; keep them in
// sync with shared.tolk if either changes.
import "shared"

// pool-core -> adapter (OP_DEPOSIT_PRINCIPAL). The principal jettons arrive in
// the same logical step via a jetton transfer referencing this queryId.
struct (0x10000031) DepositPrincipal {
    queryId: uint64
}

// pool-core -> adapter (OP_WITHDRAW_PRINCIPAL). Redeem `amount`, send to `to`.
struct (0x10000032) WithdrawPrincipal {
    queryId: uint64
    amount: coins
    to: address
}

// pool-core -> adapter (OP_HARVEST_YIELD). Sweep accrued yield to `to`.
struct (0x10000033) HarvestYield {
    queryId: uint64
    to: address
}

type AdapterRequest = DepositPrincipal | WithdrawPrincipal | HarvestYield

// adapter -> pool-core (OP_ADAPTER_REPORT). Settlement callback wrapping the
// C0 AdapterReport struct.
struct (0x10000034) AdapterReportMsg {
    queryId: uint64
    report: AdapterReport
}

// Required get-method ABI for every adapter (implemented in C6/C7, read by the
// indexer to size the prize). Documented here, not enforceable in Tolk:
//   get fun getDeployedValue(): (coins, coins)  // (principal, pendingYield)
