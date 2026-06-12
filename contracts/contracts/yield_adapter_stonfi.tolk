// C6 yield-adapter-stonfi: the production yield path. Implements the C5 adapter
// interface (identical to C7 from pool-core's view) but routes principal into a
// STON.fi v2 stable pool. Deposits provide single-sided liquidity (provide_lp) and
// hold the minted LP; withdrawals and harvests burn LP to release underlying.
// Pegged stable/stable keeps it structurally no-loss; the small swap/pool fee on the
// round trip is netted from yield, never principal.
//
// Implemented so far: wiring config, reads, and the deposit path. Withdraw (S5) and
// harvest (S6) extend the message union next. Wiring lives in a role map because the
// adapter references five addresses, which do not fit flat in one cell.
import "shared"
import "yield_adapter_iface"
import "stonfi_protocol"

const ERR_NOT_CONFIGURED = 802;
const OP_EXCESSES = 0xd53276db;

const ADAPTER_REPORT_GAS = ton("0.02");
const PROVIDE_VALUE = ton("1.0");        // funds the provide chain (router -> pool -> LP mint -> notify)
const PROVIDE_FWD_TON = ton("0.5");      // notify ton carried to the router so it acts on provide_lp
const PROVIDE_MIN_LP_OUT = 1;            // permissive against the mock; an off-chain quote sets this in prod

const ERR_INSUFFICIENT_PRINCIPAL = 803;
const BURN_VALUE = ton("1.0");           // funds the burn chain (lp wallet -> pool -> router payout -> recipient)

const BPS_DENOM = 10000;
const OP_HARVEST_STONFI = 0x10000035;    // keeper -> C6: harvest with off-chain-quoted figures
const OP_CONFIGURE_STONFI_FEE = 0x10000075;

const ROLE_POOL_CORE = 0;    // the C1 pool-core that owns this adapter
const ROLE_OWN_WALLET = 1;   // C6's own underlying (USDT) jetton wallet
const ROLE_ROUTER = 2;       // STON.fi router (destination of provide transfers)
const ROLE_LP_WALLET = 3;    // C6's LP jetton wallet (burned to redeem)
const ROLE_STONFI_POOL = 4;  // STON.fi pool (off-chain quoting reference)

@overflow1023_policy("suppress")
struct StonfiAdapterStorage {
    adminAddress: address
    principal: coins   // total underlying principal deposited; the no-loss obligation
    lpBalance: coins   // LP tokens C6 holds, tracked from mint/burn notifications
    feeBps: uint16     // disclosed residual swap/pool fee, netted from harvested yield
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

fun StonfiAdapterStorage.roleAddr(self, role: uint8): address {
    val r = self.wiring.get(role);
    assert (r.isFound) throw ERR_NOT_CONFIGURED;
    return r.loadValue();
}

struct (0x10000074) ConfigureStonfiAdapter {
    queryId: uint64
    role: uint8
    addr: address
}

struct (0x10000075) ConfigureStonfiFee {
    queryId: uint64
    feeBps: uint16
}

// keeper -> C6: harvest the accrued yield. C6 cannot read the pool's reserve/lpSupply
// on-chain, so the off-chain indexer sizes the redemption: burn `lpToBurn` LP (its
// underlying is `grossYield`, routed to the vault) and report the fee-netted yield to
// pool-core for the prize pot. Principal stays deployed.
struct (0x10000035) HarvestStonfi {
    queryId: uint64
    lpToBurn: coins
    grossYield: coins
    to: address
}

// transfer command C6 sends to its own underlying wallet to provide liquidity:
// underlying goes to the router, with the provide_lp payload nested inline so the
// router's wallet copies it into the notification it forwards to the router. Three
// addresses inline brush the cell limit; realistic stable-token coins keep the
// actual size well under 1023 bits.
@overflow1023_policy("suppress")
struct (0x0f8a7ea5) JettonTransferProvide {
    queryId: uint64
    amount: coins
    destination: address
    responseDestination: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: ProvideLpForward
}

// LP-mint notifications carry an addr_none sender (a mint has no prior holder), so
// the sender is parsed as optional here. C6 authenticates on the message sender
// (in.senderAddress), never on this field, so a null is harmless. Defined locally
// rather than widening the shared JettonTransferNotification, whose sender pool-core
// relies on as a mandatory depositor.
struct (0x7362d09c) JettonNotify {
    queryId: uint64
    amount: coins
    sender: address?
    forwardPayload: RemainingBitsAndRefs
}

// TEP-74 burn C6 sends to its LP wallet to redeem principal. sendExcessesTo doubles
// as the underlying recipient: STON.fi releases the burned LP's underlying to this
// address through the router, so principal returns straight to the depositor instead
// of round-tripping through C6.
struct (0x595f07bc) BurnLp {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

type AllowedMessageToAdapter = ConfigureStonfiAdapter | ConfigureStonfiFee | JettonNotify | WithdrawPrincipal | HarvestYield | HarvestStonfi

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

fun provideLiquidity(ownWallet: address, router: address, selfAddr: address, amount: coins) {
    val fwd: ProvideLpForward = {
        op: OP_STONFI_PROVIDE_LP,
        minLpOut: PROVIDE_MIN_LP_OUT,
        toAddress: selfAddr,
        bothPositive: false,
    };
    val transfer: JettonTransferProvide = {
        queryId: 0,
        amount: amount,
        destination: router,
        responseDestination: selfAddr,
        customPayload: null,
        forwardTonAmount: PROVIDE_FWD_TON,
        forwardPayload: fwd,
    };
    createMessage({ bounce: BounceMode.NoBounce, dest: ownWallet, value: PROVIDE_VALUE, body: transfer }).send(SEND_MODE_REGULAR);
}

fun burnLp(lpWallet: address, amount: coins, recipient: address) {
    val burn: BurnLp = {
        queryId: 0,
        jettonAmount: amount,
        sendExcessesTo: recipient,
        customPayload: null,
    };
    createMessage({ bounce: BounceMode.NoBounce, dest: lpWallet, value: BURN_VALUE, body: burn }).send(SEND_MODE_REGULAR);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToAdapter.fromSlice(in.body);

    match (msg) {
        JettonNotify => {
            var storage = lazy StonfiAdapterStorage.load();
            val ownWallet = storage.wired(ROLE_OWN_WALLET);
            val lpWallet = storage.wired(ROLE_LP_WALLET);
            assert ((ownWallet != null) & (lpWallet != null)) throw ERR_NOT_CONFIGURED;

            if (in.senderAddress == ownWallet!) {
                // principal arriving from pool-core (tagged): book it and provide to STON.fi
                var fp = msg.forwardPayload;
                if (fp.remainingBitsCount() >= 32 && fp.loadUint(32) == OP_DEPOSIT_PRINCIPAL) {
                    storage.principal += msg.amount;
                    storage.save();
                    provideLiquidity(ownWallet!, storage.roleAddr(ROLE_ROUTER), contract.getAddress(), msg.amount);
                    reportTo(storage.roleAddr(ROLE_POOL_CORE), 0, OP_DEPOSIT_PRINCIPAL, storage.principal, 0);
                }
                // else: untagged top-up or a STON.fi release-back (handled in S5/S6)
            } else {
                // LP minted to us by the pool, notified via our LP wallet
                assert (in.senderAddress == lpWallet!) throw ERR_WRONG_SENDER;
                storage.lpBalance += msg.amount;
                storage.save();
            }
        }

        WithdrawPrincipal => {
            var storage = lazy StonfiAdapterStorage.load();
            val poolCore = storage.wired(ROLE_POOL_CORE);
            val lpWallet = storage.wired(ROLE_LP_WALLET);
            assert ((poolCore != null) & (lpWallet != null)) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == poolCore!) throw ERR_UNAUTHORIZED;
            assert (msg.amount != 0 && storage.principal >= msg.amount) throw ERR_INSUFFICIENT_PRINCIPAL;

            // redeem the principal's proportional LP share; the pool releases its
            // underlying (the principal slice plus any accrued yield on it) straight to
            // the depositor. Burning by principal share keeps lpBalance/principal in
            // lockstep and the redemption rate intact for the holders who remain; yield
            // left behind is swept separately by harvest.
            val lpToBurn = storage.lpBalance * msg.amount / storage.principal;
            storage.principal -= msg.amount;
            storage.lpBalance -= lpToBurn;
            storage.save();

            burnLp(lpWallet!, lpToBurn, msg.to);
            reportTo(poolCore!, msg.queryId, OP_WITHDRAW_PRINCIPAL, storage.principal, 0);
        }

        HarvestStonfi => {
            var storage = lazy StonfiAdapterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            val poolCore = storage.wired(ROLE_POOL_CORE);
            val lpWallet = storage.wired(ROLE_LP_WALLET);
            assert ((poolCore != null) & (lpWallet != null)) throw ERR_NOT_CONFIGURED;
            assert (storage.lpBalance >= msg.lpToBurn) throw ERR_INSUFFICIENT_PRINCIPAL;

            // burn the yield-LP to the vault; principal-backing LP stays put. The fee is
            // the disclosed residual swap/pool cost, kept out of the prize-eligible figure
            // (it stays socialized in the vault). queryId 0 since pool-core only reads the op.
            val netYield = msg.grossYield - msg.grossYield * storage.feeBps / BPS_DENOM;
            storage.lpBalance -= msg.lpToBurn;
            storage.save();

            burnLp(lpWallet!, msg.lpToBurn, msg.to);
            reportTo(poolCore!, 0, OP_HARVEST_YIELD, storage.principal, netYield);
        }

        HarvestYield => {
            // pool-core's epoch-advance harvest. C6 can't price yield on-chain, so this is
            // an ack reporting zero; the real harvest runs through HarvestStonfi (keeper).
            var storage = lazy StonfiAdapterStorage.load();
            val poolCore = storage.wired(ROLE_POOL_CORE);
            assert (poolCore != null) throw ERR_NOT_CONFIGURED;
            assert (in.senderAddress == poolCore!) throw ERR_UNAUTHORIZED;
            reportTo(poolCore!, msg.queryId, OP_HARVEST_YIELD, storage.principal, 0);
        }

        ConfigureStonfiFee => {
            var storage = lazy StonfiAdapterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.feeBps = msg.feeBps;
            storage.save();
        }

        ConfigureStonfiAdapter => {
            var storage = lazy StonfiAdapterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_UNAUTHORIZED;
            storage.wiring.set(msg.role, msg.addr);
            storage.save();
        }

        else => {
            // deploy (empty body) and provide excesses (the router wallet returns
            // change to us as responseDestination) both land here and are no-ops
            if (!in.body.isEmpty()) {
                assert (in.body.remainingBitsCount() >= 32 && in.body.preloadUint(32) == OP_EXCESSES) throw 0xFFFF;
            }
        }
    }
}

get fun get_adapter_data(): (address, coins, coins, address?, address?, address?, address?, address?, uint16) {
    val storage = lazy StonfiAdapterStorage.load();
    return (
        storage.adminAddress, storage.principal, storage.lpBalance,
        storage.wired(ROLE_POOL_CORE), storage.wired(ROLE_OWN_WALLET),
        storage.wired(ROLE_ROUTER), storage.wired(ROLE_LP_WALLET), storage.wired(ROLE_STONFI_POOL),
        storage.feeBps
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
