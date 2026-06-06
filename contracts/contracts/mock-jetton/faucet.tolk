// Test faucet for the mock stables. Holds admin rights on both mock minters and,
// on request, drips a fixed USDT + USDC allocation to the sender, paying mint gas
// from its own balance. A per-address cooldown stops a single address draining it.
import "messages"
import "errors"

const FAUCET_WALLET_GAS = ton("0.05")
const ERR_NOT_CONFIGURED = 800
const ERR_RATE_LIMITED = 801

// accountHash -> last claim unix time
type ClaimsMap = map<uint256, uint32>

// Addresses + coins + the claims dict; bounded well under 1023 bits in practice.
@overflow1023_policy("suppress")
struct FaucetStorage {
    adminAddress: address
    usdtMinter: address?
    usdcMinter: address?
    dripAmount: coins
    mintValue: coins
    cooldown: uint32
    claims: ClaimsMap
}

fun FaucetStorage.load() {
    return FaucetStorage.fromCell(contract.getData())
}
fun FaucetStorage.save(self) {
    contract.setData(self.toCell())
}

// op mirrors shared.tolk OP_FAUCET_REQUEST
struct (0x10000052) RequestTokens {
    queryId: uint64
}
// faucet-internal admin op
struct (0x10000053) ConfigureMinters {
    queryId: uint64
    usdtMinter: address
    usdcMinter: address
}

type AllowedMessageToFaucet = RequestTokens | ConfigureMinters

fun sendMint(minter: address, recipient: address, amount: coins, mintValue: coins) {
    val step: InternalTransferStep = {
        queryId: 0,
        jettonAmount: amount,
        transferInitiator: null,        // mint
        sendExcessesTo: null,
        forwardTonAmount: 0,
        forwardPayload: createEmptySlice(),
    };
    val mint: MintNewJettons = {
        queryId: 0,
        mintRecipient: recipient,
        tonAmount: FAUCET_WALLET_GAS,
        internalTransferMsg: step.toCell(),
    };
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: minter,
        value: mintValue,
        body: mint,
    }).send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToFaucet.fromSlice(in.body);

    match (msg) {
        RequestTokens => {
            var storage = lazy FaucetStorage.load();
            assert ((storage.usdtMinter != null) & (storage.usdcMinter != null)) throw ERR_NOT_CONFIGURED;

            val (_, acct) = in.senderAddress.getWorkchainAndHash();
            val nowTs = blockchain.now() as uint32;
            val prev = storage.claims.get(acct);
            if (prev.isFound) {
                assert (nowTs - prev.loadValue() >= storage.cooldown) throw ERR_RATE_LIMITED;
            }
            storage.claims.set(acct, nowTs);
            storage.save();

            sendMint(storage.usdtMinter!, in.senderAddress, storage.dripAmount, storage.mintValue);
            sendMint(storage.usdcMinter!, in.senderAddress, storage.dripAmount, storage.mintValue);
        }

        ConfigureMinters => {
            var storage = lazy FaucetStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_FROM_ADMIN;
            storage.usdtMinter = msg.usdtMinter;
            storage.usdcMinter = msg.usdcMinter;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_faucet_data(): (address, address?, address?, coins, coins, uint32) {
    val storage = lazy FaucetStorage.load();
    return (storage.adminAddress, storage.usdtMinter, storage.usdcMinter, storage.dripAmount, storage.mintValue, storage.cooldown);
}

get fun get_last_claim(owner: address): uint32 {
    val storage = lazy FaucetStorage.load();
    val (_, acct) = owner.getWorkchainAndHash();
    val r = storage.claims.get(acct);
    return r.isFound ? r.loadValue() : 0;
}
