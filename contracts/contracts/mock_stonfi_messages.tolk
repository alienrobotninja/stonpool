// Mock STON.fi pool stub. Tracks the pool's accounting only: a single-asset
// `reserve` (total underlying value the LP supply is a claim on) and `lpSupply`.
// On provide_lp from the router it mints LP proportional to the deposit's share of
// the reserve, the way a balanced stable pool would after auto-swapping a
// single-sided deposit. Yield is later modeled (S2) by growing reserve without
// growing lpSupply, so each LP token redeems for more underlying. LP tokens are a
// real instance of the mock jetton with this pool as the minter admin.
import "shared"
import "mock_stonfi_messages"

const LP_MINT_TON = ton("0.1");

@overflow1023_policy("suppress")
struct PoolStorage {
    adminAddress: address
    router: address?
    lpMinter: address?
    reserve: coins
    lpSupply: coins
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
    lpMinter: address
}

type AllowedMessageToPool = ProvideLp | ConfigurePool

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
            assert ((storage.router != null) & (storage.lpMinter != null)) throw ERR_STONFI_NOT_CONFIGURED;
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
                forwardTon: 0,
            };
            val mint: MintLp = {
                queryId: msg.queryId,
                recipient: msg.toAddress,
                tonAmount: LP_MINT_TON,
                body: it.toCell(),
            };
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: storage.lpMinter!,
                value: 0,
                body: mint,
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        ConfigurePool => {
            var storage = lazy PoolStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.router = msg.router;
            storage.lpMinter = msg.lpMinter;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_pool_data(): (address, address?, address?, coins, coins) {
    val storage = lazy PoolStorage.load();
    return (storage.adminAddress, storage.router, storage.lpMinter, storage.reserve, storage.lpSupply);
}

// LP redemption rate as (reserve, lpSupply); off-chain readers compute
// underlyingPerLp = reserve / lpSupply. Quoted here so C6 (S5/S6) can size burns.
get fun get_lp_quote(): (coins, coins) {
    val storage = lazy PoolStorage.load();
    return (storage.reserve, storage.lpSupply);
}
