// C6 yield-adapter-stonfi: the production yield path. Implements the C5 adapter
// interface (identical to C7 from pool-core's view) but routes principal into a
// STON.fi v2 stable pool. Deposits provide single-sided liquidity (provide_lp) and
// hold the minted LP; withdrawals and harvests burn LP to release underlying.
// Pegged stable/stable keeps it structurally no-loss; the small swap/pool fee on the
// round trip is netted from yield, never principal.
//
// This step is the surface only: storage, role-based wiring config, and reads. The
// deposit (S4), withdraw (S5), and harvest (S6) handlers extend the message union in
// later steps. Wiring is held in a role map because the adapter references five
// addresses, which do not fit flat in one cell.
import "shared"
import "messaging"
import "yield_adapter_iface"
import "stonfi_protocol"

const ROLE_POOL_CORE = 0;    // the C1 pool-core that owns this adapter
const ROLE_OWN_WALLET = 1;   // C6's own underlying (USDT) jetton wallet
const ROLE_ROUTER = 2;       // STON.fi router (destination of provide transfers)
const ROLE_LP_WALLET = 3;    // C6's LP jetton wallet (burned to redeem)
const ROLE_STONFI_POOL = 4;  // STON.fi pool (off-chain quoting reference)

@overflow1023_policy("suppress")
struct StonfiAdapterStorage {
    adminAddress: address
    principal: coins   // total underlying principal deposited; the no-loss obligation
    lpBalance: coins   // LP tokens C6 holds, tracked locally
    wiring: map<uint8, address>
}

fun StonfiAdapterStorage.load() {
    return StonfiAdapterStorage.fromCell(contract.getData())
}
fun StonfiAdapterStorage.save(self) {
    contract.setData(self.toCell())
}

fun StonfiAdapterStorage.wired(self, role: uint8): address? {
    val r = self.wiring.get(role);
    if (r.isFound) {
        return r.loadValue();
    }
    return null;
}

// admin op: wire one role at a time (pool-core, own wallet, router, lp wallet, pool)
struct (0x10000074) ConfigureStonfiAdapter {
    queryId: uint64
    role: uint8
    addr: address
}

type AllowedMessageToAdapter = ConfigureStonfiAdapter

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToAdapter.fromSlice(in.body);

    match (msg) {
        ConfigureStonfiAdapter => {
            var storage = lazy StonfiAdapterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.wiring.set(msg.role, msg.addr);
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_adapter_data(): (address, coins, coins, address?, address?, address?, address?, address?) {
    val storage = lazy StonfiAdapterStorage.load();
    return (
        storage.adminAddress, storage.principal, storage.lpBalance,
        storage.wired(ROLE_POOL_CORE), storage.wired(ROLE_OWN_WALLET),
        storage.wired(ROLE_ROUTER), storage.wired(ROLE_LP_WALLET), storage.wired(ROLE_STONFI_POOL)
    );
}

// C5 ABI getter. Yield is not knowable on-chain without the pool quote, so it is
// reported as 0 here; the indexer derives it off-chain from lpBalance and the pool's
// get_lp_quote (lpBalance * reserve / lpSupply - principal).
get fun get_deployed_value(): (coins, coins) {
    val storage = lazy StonfiAdapterStorage.load();
    return (storage.principal, 0);
}

get fun get_lp_balance(): coins {
    val storage = lazy StonfiAdapterStorage.load();
    return storage.lpBalance;
}
