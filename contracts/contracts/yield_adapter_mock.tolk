// C7 yield-adapter-mock: implements the C5 adapter interface with predictable
// synthetic yield, for sandbox testing without STON.fi. Holds principal jettons
// in its own wallet; yield is paid from a pre-funded reserve in that same wallet,
// computed as principal * yieldBps / 10000.
import "shared"
import "messaging"
import "yield_adapter_iface"

const ADAPTER_REPORT_GAS = ton("0.02")
const ADAPTER_TRANSFER_GAS = ton("0.05")
const ERR_NOT_CONFIGURED = 802
const ERR_INSUFFICIENT_PRINCIPAL = 803

@overflow1023_policy("suppress")
struct MockAdapterStorage {
    adminAddress: address
    poolCore: address?
    jettonWallet: address?
    yieldBps: uint16
    principal: coins
}

fun MockAdapterStorage.load() {
    return MockAdapterStorage.fromCell(contract.getData())
}
fun MockAdapterStorage.save(self) {
    contract.setData(self.toCell())
}

// admin op: wire pool-core + the adapter's stable jetton wallet
struct (0x10000071) ConfigureAdapter {
    queryId: uint64
    poolCore: address
    jettonWallet: address
}

type AllowedMessageToAdapter =
    JettonTransferNotification | WithdrawPrincipal | HarvestYield | ConfigureAdapter

fun pendingYield(principal: coins, yieldBps: uint16): coins {
    return principal * yieldBps / 10000
}

fun reportTo(poolCore: address, queryId: uint64, reportedOp: uint32, principal: coins, yieldAmount: coins) {
    val report: AdapterReport = {
        reportedOp: reportedOp,
        principal: principal,
        yieldAmount: yieldAmount,
        success: true,
    };
    val msg: AdapterReportMsg = { queryId: queryId, report: report };
    createMessage({ bounce: BounceMode.NoBounce, dest: poolCore, value: ADAPTER_REPORT_GAS, body: msg }).send(SEND_MODE_REGULAR);
}

fun sendStable(jettonWallet: address, to: address, amount: coins, responseDest: address) {
    val transfer: JettonTransfer = {
        queryId: 0,
        amount: amount,
        destination: to,
        responseDestination: responseDest,
        customPayload: null,
        forwardTonAmount: 0,
        forwardPayload: null,
    };
    sendJettonTransfer(jettonWallet, ADAPTER_TRANSFER_GAS, SEND_MODE_REGULAR, transfer);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToAdapter.fromSlice(in.body);

    match (msg) {
        JettonTransferNotification => {
            var storage = lazy MockAdapterStorage.load();
            assert ((storage.poolCore != null) & (storage.jettonWallet != null)) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == storage.jettonWallet!) throw ERR_WRONG_SENDER;

            var fp = msg.forwardPayload;
            if (fp.remainingBitsCount() >= 32 && fp.loadUint(32) == OP_DEPOSIT_PRINCIPAL) {
                storage.principal += msg.amount;
                storage.save();
                reportTo(storage.poolCore!, 0, OP_DEPOSIT_PRINCIPAL, storage.principal, 0);
            }
            // otherwise: a reserve top-up; jettons are held, principal unchanged
        }

        WithdrawPrincipal => {
            var storage = lazy MockAdapterStorage.load();
            assert ((storage.poolCore != null) & (storage.jettonWallet != null)) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == storage.poolCore!) throw ERR_UNAUTHORIZED;
            assert (storage.principal >= msg.amount) throw ERR_INSUFFICIENT_PRINCIPAL;

            storage.principal -= msg.amount;
            storage.save();
            sendStable(storage.jettonWallet!, msg.to, msg.amount, storage.poolCore!);
            reportTo(storage.poolCore!, msg.queryId, OP_WITHDRAW_PRINCIPAL, storage.principal, 0);
        }

        HarvestYield => {
            var storage = lazy MockAdapterStorage.load();
            assert ((storage.poolCore != null) & (storage.jettonWallet != null)) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == storage.poolCore!) throw ERR_UNAUTHORIZED;

            val amount = pendingYield(storage.principal, storage.yieldBps);
            sendStable(storage.jettonWallet!, msg.to, amount, storage.poolCore!);
            reportTo(storage.poolCore!, msg.queryId, OP_HARVEST_YIELD, storage.principal, amount);
        }

        ConfigureAdapter => {
            var storage = lazy MockAdapterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.poolCore = msg.poolCore;
            storage.jettonWallet = msg.jettonWallet;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_deployed_value(): (coins, coins) {
    val storage = lazy MockAdapterStorage.load();
    return (storage.principal, pendingYield(storage.principal, storage.yieldBps));
}

get fun get_adapter_data(): (address, address?, address?, uint16, coins) {
    val storage = lazy MockAdapterStorage.load();
    return (storage.adminAddress, storage.poolCore, storage.jettonWallet, storage.yieldBps, storage.principal);
}
