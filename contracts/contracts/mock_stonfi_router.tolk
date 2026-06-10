// Mock STON.fi router stub. Holds the pooled underlying in its own jetton wallet
// (mirroring STON.fi, where the router owns the token vaults and pools only track
// accounting). On a transfer_notification from that wallet carrying a provide_lp
// forward payload, it forwards provide_lp to the pool. A notification without the
// provide_lp tag is ignored (swaps and other DEX ops are out of scope for the stub).
import "shared"
import "messaging"
import "mock_stonfi_messages"

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

type AllowedMessageToRouter = JettonTransferNotification | ConfigureRouter

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
