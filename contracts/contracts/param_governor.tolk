// C8 param-governor: holds the active PoolConfig and applies updates behind a
// timelock. Configs live in refs so two of them plus the wiring fit one cell.
import "shared"
import "gas"
import "governor_messages"

const ERR_NOTHING_PENDING = 442

struct GovStorage {
    admin: address
    poolCore: address
    timelock: uint32
    executeAfter: uint32          // 0 when nothing is staged
    config: Cell<PoolConfig>
    pendingConfig: Cell<PoolConfig>?
}

fun GovStorage.load() { return GovStorage.fromCell(contract.getData()) }
fun GovStorage.save(self) { contract.setData(self.toCell()) }

fun isValidConfig(c: PoolConfig): bool {
    return c.epochLength != 0
        && c.commitWindow != 0
        && c.revealWindow != 0
        && c.prizeTiers != 0
        && c.prizeTiers <= MAX_PRIZE_TIERS  // above this, DRAW_RESULT_GAS under-funds the payout loop
        && c.skimBps <= 10000
        && c.depositCutoff <= c.epochLength
        && c.commitWindow + c.revealWindow <= c.epochLength;
}

type AllowedMessage = ProposeParams | ExecuteParams

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } // deploy

    val msg = lazy AllowedMessage.fromSlice(in.body);
    match (msg) {
        ProposeParams => {
            var s = lazy GovStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            assert (isValidConfig(msg.config)) throw ERR_INVALID_PARAMS;
            s.pendingConfig = msg.config.toCell();
            s.executeAfter = (blockchain.now() as uint32) + s.timelock;
            s.save();
        }

        ExecuteParams => {
            var s = lazy GovStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            assert (s.pendingConfig != null) throw ERR_NOTHING_PENDING;
            assert (blockchain.now() >= s.executeAfter) throw ERR_TIMELOCK_ACTIVE;
            s.config = s.pendingConfig!;
            s.pendingConfig = null;
            s.executeAfter = 0;
            s.save();
            val out: ParamsUpdated = { queryId: msg.queryId, config: PoolConfig.fromCell(s.config) };
            createMessage({ bounce: BounceMode.NoBounce, dest: s.poolCore, value: ton("0.05"), body: out }).send(SEND_MODE_REGULAR);
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_OP
        }
    }
}

get fun get_config(): cell {
    val s = lazy GovStorage.load();
    return s.config;
}
get fun get_pending(): Cell<PoolConfig>? {
    val s = lazy GovStorage.load();
    return s.pendingConfig;
}
get fun get_governor_data(): (address, address, uint32, uint32) {
    val s = lazy GovStorage.load();
    return (s.admin, s.poolCore, s.timelock, s.executeAfter);
}