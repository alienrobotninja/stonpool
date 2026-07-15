// C1 pool-core: the accounting brain. Owns the depositor ledger that C2 reads,
// is the principal entry point (credits the ledger, forwards principal to the
// adapter), and orchestrates epochs/draws/payouts in later steps.
import "shared"
import "gas"
import "messaging"
import "selection"
import "pool_core_messages"
import "yield_adapter_iface"
import "draw_messages"
import "vault_messages"
import "governor_messages"

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
// PAYOUT_GAS and SETTLE_GAS now come from "gas": they are coupled to
// DRAW_RESULT_GAS in draw-engine and must not be set independently here.

struct PoolStorage {
    currentEpoch: EpochId
    depositDeadline: uint32
    epochStart: uint32
    totalPrincipal: coins
    prizePot: coins
    drawOpen: bool
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

type AllowedMessage = JettonTransferNotification | RequestWithdraw | AdvanceEpoch | SettleDraw | ClearDrawOpen | AdapterReportMsg | DrawResultMsg | ParamsUpdated | ConfigureCore

// StartDraw is currently the only send here that is not NoBounce, so it is the only
// thing that can reach onBouncedMessage. Kept as a union anyway: if another send is
// ever made bounceable, it must be added here deliberately rather than silently
// falling through and being mistaken for a StartDraw.
type BounceableMessage = StartDraw

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

            // forward principal to the adapter; the inline tag tells it to credit
            // principal (vs. hold as reserve). forwardTon > 0 so the adapter is notified.
            val transfer: JettonTransferTagged = {
                queryId: 0,
                amount: msg.amount,
                destination: roleAddr(s.wiring, ROLE_ADAPTER),
                responseDestination: s.admin,
                customPayload: null,
                forwardTonAmount: DEPOSIT_FWD_TON,
                forwardOp: OP_DEPOSIT_PRINCIPAL,
            };
            sendJettonTransferTagged(jw, DEPOSIT_FWD_GAS, SEND_MODE_REGULAR, transfer);
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
            // Refuse to advance past a draw that has not settled. draw-engine does
            // reject the StartDraw below with ERR_BUSY, but that send is NoBounce and
            // its throw happens in a separate transaction, so the rejection never
            // reaches us: we would already have committed the epoch bump, leaving the
            // previous draw stranded and the new epoch with no draw at all. The bump
            // cannot be undone after the fact, so the only correct place to stop is
            // here, while we still own the decision.
            assert (!s.drawOpen) throw ERR_BUSY;

            val endedEpoch = s.currentEpoch;
            s.currentEpoch += 1;
            s.epochStart = nowTs;
            s.depositDeadline = nowTs + cfg.epochLength - cfg.depositCutoff;
            s.drawOpen = true;
            s.save();

            // harvest the ended epoch's yield into the prize pot, then open the draw for it
            val harvest: HarvestYield = { queryId: 0, to: roleAddr(s.wiring, ROLE_VAULT) };
            createMessage({ bounce: BounceMode.NoBounce, dest: roleAddr(s.wiring, ROLE_ADAPTER), value: HARVEST_GAS, body: harvest }).send(SEND_MODE_REGULAR);

            // Bounceable, unlike every other send here. drawOpen was just armed above,
            // and only a DrawResultMsg clears it - which never arrives if the draw never
            // opened. draw-engine throws ERR_INVALID_PARAMS on an unconfigured engine
            // (commitWindow/revealWindow == 0), so without a bounce the flag would strand
            // true and ERR_BUSY would block every future advance permanently. The bounce
            // is the only signal that the draw did not start. Body is 128 bits, so the
            // cheapest mode carries it intact.
            val start: StartDraw = { queryId: 0, epoch: endedEpoch };
            createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: roleAddr(s.wiring, ROLE_DRAW_ENGINE), value: START_DRAW_GAS, body: start }).send(SEND_MODE_REGULAR);
        }

        AdapterReportMsg => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == roleAddr(s.wiring, ROLE_ADAPTER)) throw ERR_UNAUTHORIZED;
            // harvested yield funds the prize pot; other reports just confirm ledger moves
            if (msg.report.reportedOp == OP_HARVEST_YIELD && msg.report.success) {
                s.prizePot += msg.report.yieldAmount;
                s.save();
            }
        }

        DrawResultMsg => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == roleAddr(s.wiring, ROLE_DRAW_ENGINE)) throw ERR_UNAUTHORIZED;
            val cfg = PoolConfig.fromCell(s.config);
            val vault = roleAddr(s.wiring, ROLE_VAULT);

            // The draw is settled the moment its result lands, whatever we then do
            // with the pot. This must be cleared before the eligible==0 branch below:
            // that branch returns without saving, so clearing afterwards would leave
            // drawOpen stuck true and every future AdvanceEpoch would throw ERR_BUSY,
            // deadlocking the pool permanently.
            s.drawOpen = false;
            s.save();

            val eligible = eligibleCount(s.ledger, s.currentEpoch, cfg.minHoldEpochs);
            if (eligible == 0) { return; } // no eligible depositors: pot rolls over

            val pot = s.prizePot;
            val skim = pot * cfg.skimBps / 10000;
            val distributable = pot - skim;
            var tiers = cfg.prizeTiers as int;
            if (tiers > eligible) { tiers = eligible; }
            val perTier = distributable / tiers;
            val remainder = distributable - perTier * tiers;

            s.prizePot = 0; // effects before interactions; ledger stays intact in memory for selection
            s.save();

            if (skim != 0) {
                val skimPay: Payout = { queryId: 0, to: s.admin, amount: skim };
                createMessage({ bounce: BounceMode.NoBounce, dest: vault, value: PAYOUT_GAS, body: skimPay }).send(SEND_MODE_REGULAR);
            }

            var chosen = createEmptyMap<address, bool>();
            var tier = 0;
            while (tier < tiers) {
                val winner = selectWinnerEx(s.ledger, s.currentEpoch, cfg.minHoldEpochs, false, tierWord(msg.result.seed, tier), chosen);
                chosen.set(winner, true);
                var amount = perTier;
                if (tier == 0) { amount += remainder; }
                val pay: Payout = { queryId: 0, to: winner, amount: amount };
                createMessage({ bounce: BounceMode.NoBounce, dest: vault, value: PAYOUT_GAS, body: pay }).send(SEND_MODE_REGULAR);
                tier += 1;
            }
        }

        SettleDraw => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            val fin: FinalizeDraw = { queryId: 0 };
            createMessage({ bounce: BounceMode.NoBounce, dest: roleAddr(s.wiring, ROLE_DRAW_ENGINE), value: SETTLE_GAS, body: fin }).send(SEND_MODE_REGULAR);
        }

        ClearDrawOpen => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            // deliberately unconditional: if the flag is already clear this is a no-op,
            // and refusing here would just add a way for the hatch itself to fail shut
            s.drawOpen = false;
            s.save();
        }

        ParamsUpdated => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == roleAddr(s.wiring, ROLE_GOVERNOR)) throw ERR_UNAUTHORIZED;
            s.config = msg.config.toCell();
            s.save();
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

// A bounce means the destination threw before committing anything, so the action it
// was asked to perform did not happen. Tolk rejects bounces with exit code 0 when this
// entrypoint is absent, which is silent by construction - the failure mode Finding B
// describes. Only StartDraw is bounceable; see AdvanceEpoch.
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val msg = lazy BounceableMessage.fromSlice(in.bouncedBody);
    match (msg) {
        StartDraw => {
            // the draw never opened: release the guard so the admin can fix the engine
            // and retry AdvanceEpoch. The epoch bump itself stands - it cannot be undone
            // from a later transaction, and re-advancing is not what we want anyway.
            var s = lazy PoolStorage.load();
            s.drawOpen = false;
            s.save();
        }
        else => {}
    }
}

get fun get_config(): cell {
    val s = lazy PoolStorage.load();
    return s.config;
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
// true from AdvanceEpoch (which opens a draw) until that draw's result lands.
// AdvanceEpoch throws ERR_BUSY while set; the keeper reads this to know whether it
// must settle before advancing.
get fun get_draw_open(): bool {
    val s = lazy PoolStorage.load();
    return s.drawOpen;
}
// the coupled gas budget from "gas", exposed so tests assert against the values the
// contract actually ships rather than hardcoding their own copies
get fun get_gas_budget(): (int, int, int, int) {
    return (SETTLE_GAS, DRAW_RESULT_GAS, PAYOUT_GAS, MAX_PRIZE_TIERS);
}
