// Mock STON.fi router stub. Holds the pooled underlying in its own jetton wallet
// (mirroring STON.fi, where the router owns the token vaults and pools only track
// accounting). On a transfer_notification from that wallet carrying a provide_lp
// forward payload it forwards provide_lp to the pool. On PayOut from the pool (the
// pay_to leg of a burn) it releases underlying from the vault to the holder. A
// notification without the provide_lp tag is ignored.
import "shared"
import "messaging"
import "stonfi_protocol"
import "mock_stonfi_messages"

const PAYOUT_GAS = ton("0.05");
const RELEASE_NOTIFY_TON = ton("0.05");

@overflow1023_policy("suppress")
struct RouterStorage {
    adminAddress: address
    jettonWallet: address?
    pool: address?
}

fun RouterStorage.load() {
    return RouterStorage.fromCell(contract.getData())
}
fun RouterStorage.save(self) {
    contract.setData(self.toCell())
}

struct (0x7e571001) ConfigureRouter {
    queryId: uint64
    jettonWallet: address
    pool: address
}

type AllowedMessageToRouter = JettonTransferNotification | PayOut | ConfigureRouter

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToRouter.fromSlice(in.body);

    match (msg) {
        JettonTransferNotification => {
            var storage = lazy RouterStorage.load();
            assert ((storage.jettonWallet != null) & (storage.pool != null)) throw ERR_STONFI_NOT_CONFIGURED;
            assert (in.senderAddress == storage.jettonWallet!) throw ERR_WRONG_SENDER;

            var fp = msg.forwardPayload;
            if (fp.remainingBitsCount() >= 32 && fp.preloadUint(32) == OP_STONFI_PROVIDE_LP) {
                val req = ProvideLpForward.fromSlice(fp);
                val fwd: ProvideLp = {
                    queryId: msg.queryId,
                    amount: msg.amount,
                    toAddress: req.toAddress,
                    minLpOut: req.minLpOut,
                    bothPositive: req.bothPositive,
                };
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: storage.pool!,
                    value: 0,
                    body: fwd,
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
            }
            // untagged notification: nothing to do, jettons stay in the router vault
        }

        PayOut => {
            var storage = lazy RouterStorage.load();
            assert ((storage.jettonWallet != null) & (storage.pool != null)) throw ERR_STONFI_NOT_CONFIGURED;
            assert (in.senderAddress == storage.pool!) throw ERR_UNAUTHORIZED;

            val transfer: JettonTransfer = {
                queryId: msg.queryId,
                amount: msg.amount,
                destination: msg.to,
                responseDestination: msg.to,
                customPayload: null,
                forwardTonAmount: RELEASE_NOTIFY_TON,
                forwardPayload: null,
            };
            sendJettonTransfer(storage.jettonWallet!, PAYOUT_GAS + RELEASE_NOTIFY_TON, SEND_MODE_REGULAR, transfer);
        }

        ConfigureRouter => {
            var storage = lazy RouterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.jettonWallet = msg.jettonWallet;
            storage.pool = msg.pool;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_router_data(): (address, address?, address?) {
    val storage = lazy RouterStorage.load();
    return (storage.adminAddress, storage.jettonWallet, storage.pool);
}
