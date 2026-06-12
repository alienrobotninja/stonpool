// Mock STON.fi pool stub, acting as the LP jetton master. Tracks pool accounting
// only: a single-asset `reserve` (underlying the LP supply is a claim on) and
// `lpSupply`. On provide_lp from the router it mints LP proportional to the
// deposit's reserve share (the way a balanced stable pool would after auto-swapping
// a single-sided deposit) by deploying the recipient's LP wallet directly. On an LP
// burn the wallet notifies this pool, which releases the proportional underlying via
// the router vault. Yield is modeled with accrueYield: grow reserve, leave lpSupply,
// so each LP token redeems for more underlying. LP wallets are real mock-jetton
// wallets with this pool as their minter.
import "shared"
import "mock_stonfi_messages"

const LP_MINT_TON = ton("0.2");
// LP mint forwards a small notification so the recipient (C6) is told the minted
// amount and can track its lpBalance precisely; plain holders ignore it.
const LP_MINT_NOTIFY_TON = ton("0.05");

@overflow1023_policy("suppress")
struct PoolStorage {
    adminAddress: address
    router: address?
    reserve: coins
    lpSupply: coins
    lpWalletCode: cell
}

fun PoolStorage.load() {
    return PoolStorage.fromCell(contract.getData())
}
fun PoolStorage.save(self) {
    contract.setData(self.toCell())
}

struct (0x7e571002) ConfigurePool {
    queryId: uint64
    router: address
}

type AllowedMessageToPool = ProvideLp | LpBurnNotification | AccrueYield | ConfigurePool

fun lpForDeposit(amount: coins, reserve: coins, lpSupply: coins): coins {
    if (lpSupply == 0) {
        return amount; // bootstrap: LP:underlying starts 1:1
    }
    return amount * lpSupply / reserve;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToPool.fromSlice(in.body);

    match (msg) {
        ProvideLp => {
            var storage = lazy PoolStorage.load();
            assert (storage.router != null) throw ERR_STONFI_NOT_CONFIGURED;
            assert (in.senderAddress == storage.router!) throw ERR_UNAUTHORIZED;

            val lpOut = lpForDeposit(msg.amount, storage.reserve, storage.lpSupply);
            assert (lpOut >= msg.minLpOut && lpOut != 0) throw ERR_STONFI_SLIPPAGE;

            storage.reserve += msg.amount;
            storage.lpSupply += lpOut;
            storage.save();

            val it: LpMintInternal = {
                queryId: msg.queryId,
                amount: lpOut,
                initiator: null,
                excessesTo: null,
                forwardTon: LP_MINT_NOTIFY_TON,
            };
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: lpDeployTarget(msg.toAddress, contract.getAddress(), storage.lpWalletCode),
                value: LP_MINT_TON,
                body: it,
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        LpBurnNotification => {
            var storage = lazy PoolStorage.load();
            assert (storage.router != null) throw ERR_STONFI_NOT_CONFIGURED;
            // authentic only if it came from the burn initiator's own LP wallet
            assert (in.senderAddress == lpWalletAddress(msg.burnInitiator, contract.getAddress(), storage.lpWalletCode)) throw ERR_WRONG_SENDER;
            assert (storage.lpSupply >= msg.jettonAmount) throw ERR_STONFI_INSUFFICIENT_LP;

            val underlying = msg.jettonAmount * storage.reserve / storage.lpSupply;
            storage.lpSupply -= msg.jettonAmount;
            storage.reserve -= underlying;
            storage.save();

            val po: PayOut = { queryId: msg.queryId, to: msg.burnInitiator, amount: underlying };
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: storage.router!,
                value: 0,
                body: po,
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        AccrueYield => {
            var storage = lazy PoolStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.reserve += msg.amount;
            storage.save();
        }

        ConfigurePool => {
            var storage = lazy PoolStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.router = msg.router;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_pool_data(): (address, address?, coins, coins) {
    val storage = lazy PoolStorage.load();
    return (storage.adminAddress, storage.router, storage.reserve, storage.lpSupply);
}

// LP redemption rate inputs; off-chain readers compute underlyingPerLp = reserve / lpSupply.
get fun get_lp_quote(): (coins, coins) {
    val storage = lazy PoolStorage.load();
    return (storage.reserve, storage.lpSupply);
}

get fun get_lp_wallet(owner: address): address {
    val storage = lazy PoolStorage.load();
    return lpWalletAddress(owner, contract.getAddress(), storage.lpWalletCode);
}
