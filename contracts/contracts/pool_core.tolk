// C1 pool-core: the accounting brain. Owns the depositor ledger that C2 reads,
// is the principal entry point (credits the ledger, forwards principal to the
// adapter), and orchestrates epochs/draws/payouts in later steps.
import "shared"
import "messaging"
import "selection"
import "pool_core_messages"
import "yield_adapter_iface"
import "draw_messages"

const ERR_NOT_CONFIGURED = 806

const ROLE_JETTON_WALLET = 0;
const ROLE_ADAPTER = 1;
const ROLE_DRAW_ENGINE = 2;
const ROLE_VAULT = 3;
const ROLE_GOVERNOR = 4;

const DEPOSIT_FWD_GAS = ton("0.1");
const DEPOSIT_FWD_TON = ton("0.05");
const WITHDRAW_GAS = ton("0.15");
const HARVEST_GAS = ton("0.15");
const START_DRAW_GAS = ton("0.05");

struct PoolStorage {
    currentEpoch: EpochId
    depositDeadline: uint32
    epochStart: uint32
    totalPrincipal: coins
    prizePot: coins
    admin: address
    config: Cell<PoolConfig>
    wiring: map<uint8, address>
    ledger: Ledger
}

fun PoolStorage.load() { return PoolStorage.fromCell(contract.getData()) }
fun PoolStorage.save(self) { contract.setData(self.toCell()) }

fun roleAddr(wiring: map<uint8, address>, role: uint8): address {
    val r = wiring.get(role);
    assert (r.isFound) throw ERR_NOT_CONFIGURED;
    return r.loadValue();
}

fun minHoldOf(config: Cell<PoolConfig>): uint16 {
    return PoolConfig.fromCell(config).minHoldEpochs;
}

type AllowedMessage = JettonTransferNotification | RequestWithdraw | AdvanceEpoch | ConfigureCore

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } // deploy

    val msg = lazy AllowedMessage.fromSlice(in.body);
    match (msg) {
        JettonTransferNotification => {
            var s = lazy PoolStorage.load();
            val jw = roleAddr(s.wiring, ROLE_JETTON_WALLET);
            assert (in.senderAddress == jw) throw ERR_WRONG_SENDER;
            assert (blockchain.now() < s.depositDeadline) throw ERR_DEPOSIT_CLOSED;

            // beneficiary defaults to the depositor; an explicit DepositPayload overrides it
            var beneficiary = msg.sender;
            var fp = msg.forwardPayload;
            if (fp.remainingBitsCount() >= 32) {
                val op = fp.loadUint(32);
                if (op == OP_DEPOSIT && fp.remainingBitsCount() >= 267) {
                    beneficiary = fp.loadAddress();
                }
            }

            // credit: accumulate weight, keep the earliest joinEpoch
            var entry: LedgerEntry = { weight: 0, joinEpoch: s.currentEpoch };
            val existing = s.ledger.get(beneficiary);
            if (existing.isFound) { entry = existing.loadValue(); }
            entry.weight += msg.amount;
            s.ledger.set(beneficiary, entry);
            s.totalPrincipal += msg.amount;
            s.save();

            // forward principal to the adapter, tagged so it credits principal (earns yield)
            val adapter = roleAddr(s.wiring, ROLE_ADAPTER);
            val tag = beginCell().storeUint(OP_DEPOSIT_PRINCIPAL, 32).endCell();
            val transfer: JettonTransfer = {
                queryId: 0,
                amount: msg.amount,
                destination: adapter,
                responseDestination: s.admin,
                customPayload: null,
                forwardTonAmount: DEPOSIT_FWD_TON,
                forwardPayload: tag,
            };
            sendJettonTransfer(jw, DEPOSIT_FWD_GAS, SEND_MODE_REGULAR, transfer);
        }

        RequestWithdraw => {
            var s = lazy PoolStorage.load();
            val who = in.senderAddress;
            val found = s.ledger.get(who);
            assert (found.isFound) throw ERR_NOTHING_TO_WITHDRAW;
            val entry = found.loadValue();
            assert (isEligible(entry, s.currentEpoch, minHoldOf(s.config))) throw ERR_WITHDRAW_TOO_EARLY;
            assert (msg.amount != 0 && msg.amount <= entry.weight) throw ERR_NOTHING_TO_WITHDRAW;

            val remaining = entry.weight - msg.amount;
            if (remaining == 0) {
                s.ledger.delete(who);
            } else {
                var e2 = entry;
                e2.weight = remaining;
                s.ledger.set(who, e2);
            }
            s.totalPrincipal -= msg.amount;
            s.save();

            // adapter returns the principal jettons to the depositor
            val adapter = roleAddr(s.wiring, ROLE_ADAPTER);
            val req: WithdrawPrincipal = { queryId: msg.queryId, amount: msg.amount, to: who };
            createMessage({ bounce: BounceMode.NoBounce, dest: adapter, value: WITHDRAW_GAS, body: req }).send(SEND_MODE_REGULAR);
        }

        AdvanceEpoch => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            val cfg = PoolConfig.fromCell(s.config);
            val nowTs = blockchain.now() as uint32;
            assert (nowTs >= s.epochStart + cfg.epochLength) throw ERR_EPOCH_NOT_ENDED;

            val endedEpoch = s.currentEpoch;
            s.currentEpoch += 1;
            s.epochStart = nowTs;
            s.depositDeadline = nowTs + cfg.epochLength - cfg.depositCutoff;
            s.save();

            // harvest the ended epoch's yield into the prize pot, then open the draw for it
            val harvest: HarvestYield = { queryId: 0, to: roleAddr(s.wiring, ROLE_VAULT) };
            createMessage({ bounce: BounceMode.NoBounce, dest: roleAddr(s.wiring, ROLE_ADAPTER), value: HARVEST_GAS, body: harvest }).send(SEND_MODE_REGULAR);

            val start: StartDraw = { queryId: 0, epoch: endedEpoch };
            createMessage({ bounce: BounceMode.NoBounce, dest: roleAddr(s.wiring, ROLE_DRAW_ENGINE), value: START_DRAW_GAS, body: start }).send(SEND_MODE_REGULAR);
        }

        ConfigureCore => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            s.wiring.set(msg.role, msg.addr);
            s.save();
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_OP
        }
    }
}

get fun get_pool_data(): (EpochId, uint32, coins, coins) {
    val s = lazy PoolStorage.load();
    return (s.currentEpoch, s.depositDeadline, s.totalPrincipal, s.prizePot);
}
get fun get_balance_of(who: address): (coins, EpochId) {
    val s = lazy PoolStorage.load();
    val r = s.ledger.get(who);
    if (!r.isFound) { return (0, 0); }
    val e = r.loadValue();
    return (e.weight, e.joinEpoch);
}
get fun get_participant_count(): int {
    val s = lazy PoolStorage.load();
    return participantCount(s.ledger);
}
get fun get_total_weight(): coins {
    val s = lazy PoolStorage.load();
    return eligibleWeight(s.ledger, s.currentEpoch, minHoldOf(s.config), false);
}
get fun get_odds(who: address): int {
    val s = lazy PoolStorage.load();
    return oddsBps(s.ledger, who, s.currentEpoch, minHoldOf(s.config));
}
get fun preview_winner(word: uint256): address {
    val s = lazy PoolStorage.load();
    return selectWinner(s.ledger, s.currentEpoch, minHoldOf(s.config), false, word);
}
