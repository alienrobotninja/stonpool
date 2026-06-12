// C4 jetton-vault: prize-pot custody. Receives harvested yield as a TEP-74
// transfer_notification (credits the pot) and pays winners on pool-core's
// Payout command. Holds prize jettons only; principal lives in the adapter.
import "shared"
import "messaging"
import "vault_messages"

const ERR_NOT_CONFIGURED = 804
const ERR_INSUFFICIENT_POT = 805
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
        }

        Payout => {
            var s = lazy VaultStorage.load();
            assert (s.poolCore != null && s.jettonWallet != null) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == s.poolCore!) throw ERR_UNAUTHORIZED;
            assert (msg.amount <= s.potBalance) throw ERR_INSUFFICIENT_POT;
            s.potBalance -= msg.amount;
            s.save();
            val transfer: JettonTransfer = {
                queryId: msg.queryId,
                amount: msg.amount,
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
