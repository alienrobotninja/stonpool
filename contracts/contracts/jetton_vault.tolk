// C4 jetton-vault: prize-pot custody. Receives harvested yield as a TEP-74
// transfer_notification (credits the pot) and pays winners on pool-core's
// Payout command. Holds prize jettons only; principal lives in the adapter.
import "shared"
import "messaging"
import "vault_messages"

const ERR_NOT_CONFIGURED = 804
const VAULT_TRANSFER_GAS = ton("0.05")

struct VaultStorage {
    adminAddress: address
    poolCore: address?
    jettonWallet: address?
    potBalance: coins
}

fun VaultStorage.load() { return VaultStorage.fromCell(contract.getData()) }
fun VaultStorage.save(self) { contract.setData(self.toCell()) }

type AllowedMessage = JettonTransferNotification | Payout | ConfigureVault

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } // deploy

    val msg = lazy AllowedMessage.fromSlice(in.body);
    match (msg) {
        JettonTransferNotification => {
            var s = lazy VaultStorage.load();
            assert (s.jettonWallet != null) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == s.jettonWallet!) throw ERR_WRONG_SENDER;
            s.potBalance += msg.amount;
            s.save();

            // Tell pool-core what actually landed, so its prizePot tracks this pot rather
            // than the keeper's estimate of it. Carries the notification's own forward TON
            // rather than spending the vault's balance, and IGNORE_ERRORS because the credit
            // above is already committed: if the yield arrives with too little gas to relay
            // the report, the jettons are still ours and still in the pot, and the pot must
            // not un-credit itself over a message it could not afford. A report lost that
            // way leaves prizePot short of potBalance - visible, safe, and what SyncPot is
            // for. The reverse, prizePot ahead of potBalance, is the one that loses prizes,
            // and this ordering makes it unreachable.
            if (s.poolCore != null) {
                val credit: VaultCredit = { queryId: 0, amount: msg.amount };
                createMessage({ bounce: BounceMode.NoBounce, dest: s.poolCore!, value: 0, body: credit })
                    .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        Payout => {
            var s = lazy VaultStorage.load();
            assert (s.poolCore != null && s.jettonWallet != null) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == s.poolCore!) throw ERR_UNAUTHORIZED;

            // Pay what is here rather than throwing. Since VaultCredit made prizePot a
            // mirror of this balance, an over-ask should now be unreachable - but the cost
            // of being wrong is asymmetric. pool-core zeroes prizePot before it sends, and
            // these are NoBounce, so a throw here means the winner is never paid, the pot
            // is stranded, and pool-core never learns. Clamping degrades that to a short
            // payment: the prize is smaller, the winner is still paid, and the residue
            // stays visible in potBalance for SyncPot to reconcile.
            var pay = msg.amount;
            if (pay > s.potBalance) { pay = s.potBalance; }
            if (pay == 0) { return; } // nothing to pay: a transfer of 0 just burns gas
            s.potBalance -= pay;
            s.save();
            val transfer: JettonTransfer = {
                queryId: msg.queryId,
                amount: pay,
                destination: msg.to,
                responseDestination: s.poolCore!,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: null,
            };
            sendJettonTransfer(s.jettonWallet!, VAULT_TRANSFER_GAS, SEND_MODE_REGULAR, transfer);
        }

        ConfigureVault => {
            var s = lazy VaultStorage.load();
            assert (in.senderAddress == s.adminAddress) throw ERR_UNAUTHORIZED;
            s.poolCore = msg.poolCore;
            s.jettonWallet = msg.jettonWallet;
            s.save();
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_OP
        }
    }
}

get fun get_vault_data(): (address, address?, address?, coins) {
    val s = lazy VaultStorage.load();
    return (s.adminAddress, s.poolCore, s.jettonWallet, s.potBalance);
}
