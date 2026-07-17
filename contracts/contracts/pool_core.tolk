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

// How the pool is parameterised and what it is wired to. One cell rather than two root
// fields because the root cell was at TON's hard 4-ref limit - config, wiring, ledger,
// pending - and a full root silently decides what later steps are allowed to add. These
// two are the right pair to fold: both are governed rather than per-depositor, and each
// has exactly one write site, so the pack cost lands on two admin paths and nowhere else.
// Keeping config in its own cell here also leaves it free to grow past 292 bits.
struct PoolSetup {
    config: Cell<PoolConfig>
    wiring: map<uint8, address>
}

struct PoolStorage {
    currentEpoch: EpochId
    depositDeadline: uint32
    epochStart: uint32
    totalPrincipal: coins
    prizePot: coins
    drawOpen: bool
    withdrawNonce: uint64
    admin: address
    setup: Cell<PoolSetup>
    ledger: Ledger
    pending: map<uint64, PendingWithdraw>
}

fun PoolStorage.load() { return PoolStorage.fromCell(contract.getData()) }
fun PoolStorage.save(self) { contract.setData(self.toCell()) }

// Undo a journaled debit: put the amount back on the ledger and drop the record. The
// bounce handler and reclaim are the same operation reached two ways - the adapter said
// no, or the adapter never said anything - so they must not drift apart.
//
// Add back, never overwrite. A partial withdraw left the entry in place with its own
// joinEpoch; the journal's copy is only authoritative when the entry is gone, which is
// exactly when this default is the one that survives. Same shape as the deposit path.
fun PoolStorage.restorePending(mutate self, queryId: uint64, rec: PendingWithdraw) {
    var entry: LedgerEntry = { weight: 0, joinEpoch: rec.joinEpoch };
    val existing = self.ledger.get(rec.who);
    if (existing.isFound) { entry = existing.loadValue(); }
    entry.weight += rec.amount;
    self.ledger.set(rec.who, entry);
    self.totalPrincipal += rec.amount;
    self.pending.delete(queryId);
}

fun roleAddr(wiring: map<uint8, address>, role: uint8): address {
    val r = wiring.get(role);
    assert (r.isFound) throw ERR_NOT_CONFIGURED;
    return r.loadValue();
}

fun PoolStorage.cfg(self): PoolConfig {
    return PoolConfig.fromCell(PoolSetup.fromCell(self.setup).config);
}

fun PoolStorage.role(self, role: uint8): address {
    return roleAddr(PoolSetup.fromCell(self.setup).wiring, role);
}

type AllowedMessage = JettonTransferNotification | RequestWithdraw | AdvanceEpoch | SettleDraw | ClearDrawOpen | ReclaimWithdraw | AdapterReportMsg | VaultCredit | DrawResultMsg | ParamsUpdated | ConfigureCore

// Bounces are the only signal that a NoBounce-era send never happened. Every send
// listed here must be deliberate: an unlisted bounceable send falls through to the
// else arm and is silently ignored, and a mislisted one is mistaken for its neighbour.
//
// Both entries ride Only256BitsOfBody. StartDraw fits whole (128 bits). WithdrawPrincipal
// does not - it is ~487 bits and the `to` address is truncated away - but the handler
// never reads past queryId: the journal holds everything needed to undo the debit, so
// the bounce only has to name the entry. `lazy` loads fields on demand, so the truncated
// tail is never touched. See onBouncedMessage.
type BounceableMessage = StartDraw | WithdrawPrincipal

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } // deploy

    val msg = lazy AllowedMessage.fromSlice(in.body);
    match (msg) {
        JettonTransferNotification => {
            var s = lazy PoolStorage.load();
            val jw = s.role(ROLE_JETTON_WALLET);
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
                destination: s.role(ROLE_ADAPTER),
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
            assert (isEligible(entry, s.currentEpoch, s.cfg().minHoldEpochs)) throw ERR_WITHDRAW_TOO_EARLY;
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

            // Journal the debit in the same transaction that performs it. The send below
            // is NoBounce and the adapter throws ERR_INSUFFICIENT_PRINCIPAL on a shortfall,
            // so without this the debit is unrecoverable: the ledger entry (and with it
            // joinEpoch) is gone and the jettons never come back. This record is written
            // atomically with the debit, so it cannot be missed the way a bounce can.
            //
            // The key is ours, not the caller's. msg.queryId is caller-supplied, and a map
            // keyed on it lets two withdrawals pick the same key and silently overwrite
            // each other's journal entry - the exact loss this is meant to prevent. The
            // adapter echoes whatever queryId we send back on the report, so a private
            // monotonic nonce round-trips just as well and cannot collide.
            val qid = s.withdrawNonce;
            s.withdrawNonce += 1;
            val rec: PendingWithdraw = { who: who, amount: msg.amount, joinEpoch: entry.joinEpoch, requestedAt: blockchain.now() as uint32 };
            s.pending.set(qid, rec);
            s.save();

            // adapter returns the principal jettons to the depositor. Bounceable: the
            // adapter throws ERR_INSUFFICIENT_PRINCIPAL when its principal is short of
            // what our ledger claims, and the bounce is what tells us the debit above
            // never happened. Only256BitsOfBody truncates the body after ~256 bits, which
            // is fine - onBouncedMessage reads only the queryId and recovers the rest from
            // the journal - and it is the cheapest mode, which is what makes the bounce
            // likely to actually fire on WITHDRAW_GAS.
            val adapter = s.role(ROLE_ADAPTER);
            val req: WithdrawPrincipal = { queryId: qid, amount: msg.amount, to: who };
            createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: adapter, value: WITHDRAW_GAS, body: req }).send(SEND_MODE_REGULAR);
        }

        AdvanceEpoch => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            val cfg = s.cfg();
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
            val harvest: HarvestYield = { queryId: 0, to: s.role(ROLE_VAULT) };
            createMessage({ bounce: BounceMode.NoBounce, dest: s.role(ROLE_ADAPTER), value: HARVEST_GAS, body: harvest }).send(SEND_MODE_REGULAR);

            // Bounceable, unlike every other send here. drawOpen was just armed above,
            // and only a DrawResultMsg clears it - which never arrives if the draw never
            // opened. draw-engine throws ERR_INVALID_PARAMS on an unconfigured engine
            // (commitWindow/revealWindow == 0), so without a bounce the flag would strand
            // true and ERR_BUSY would block every future advance permanently. The bounce
            // is the only signal that the draw did not start. Body is 128 bits, so the
            // cheapest mode carries it intact.
            val start: StartDraw = { queryId: 0, epoch: endedEpoch };
            createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: s.role(ROLE_DRAW_ENGINE), value: START_DRAW_GAS, body: start }).send(SEND_MODE_REGULAR);
        }

        AdapterReportMsg => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.role(ROLE_ADAPTER)) throw ERR_UNAUTHORIZED;
            // The harvest report is informational now. It carries netYield, computed from a
            // grossYield the keeper passed in before STON.fi executed the burn - an estimate
            // of a trade, not its settlement. Crediting prizePot from it is what put pool-core
            // and the vault on two different numbers. The vault reports the jettons that
            // actually land (VaultCredit); this report is kept only as the harvest ack.
            if (msg.report.reportedOp == OP_HARVEST_YIELD) { return; }
            // The withdraw ack is the journal's normal exit: the adapter has redeemed and
            // paid out, so the record has done its job. Both adapters echo the queryId we
            // sent (mock line 96, stonfi line 216), which is the map key. An unknown key is
            // a no-op - delete returns false rather than throwing - so a duplicate or
            // spurious report cannot brick the handler.
            if (msg.report.reportedOp == OP_WITHDRAW_PRINCIPAL && msg.report.success) {
                s.pending.delete(msg.queryId);
                s.save();
            }
        }

        VaultCredit => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.role(ROLE_VAULT)) throw ERR_UNAUTHORIZED;
            s.prizePot += msg.amount;
            s.save();
        }

        DrawResultMsg => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.role(ROLE_DRAW_ENGINE)) throw ERR_UNAUTHORIZED;
            val cfg = s.cfg();
            val vault = s.role(ROLE_VAULT);

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
            createMessage({ bounce: BounceMode.NoBounce, dest: s.role(ROLE_DRAW_ENGINE), value: SETTLE_GAS, body: fin }).send(SEND_MODE_REGULAR);
        }

        ClearDrawOpen => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            // deliberately unconditional: if the flag is already clear this is a no-op,
            // and refusing here would just add a way for the hatch itself to fail shut
            s.drawOpen = false;
            s.save();
        }

        ReclaimWithdraw => {
            var s = lazy PoolStorage.load();
            val found = s.pending.get(msg.queryId);
            if (!found.isFound) { return; } // already acked, bounced or reclaimed: idempotent
            val rec = found.loadValue();
            // The age gate is the whole safety of this path. Reclaim before the adapter has
            // answered and a withdrawal that then succeeds pays the depositor twice: once in
            // jettons, once in restored ledger weight. TON resolves a message in seconds, so
            // one epoch of wall clock is far past any real round trip while still bounded by
            // the governed config, which means demo timings shrink it automatically.
            val cfg = s.cfg();
            assert (blockchain.now() >= rec.requestedAt + cfg.epochLength) throw ERR_RECLAIM_TOO_EARLY;
            s.restorePending(msg.queryId, rec);
            s.save();
        }

        ParamsUpdated => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.role(ROLE_GOVERNOR)) throw ERR_UNAUTHORIZED;
            var setup = PoolSetup.fromCell(s.setup);
            setup.config = msg.config.toCell();
            s.setup = setup.toCell();
            s.save();
        }

        ConfigureCore => {
            var s = lazy PoolStorage.load();
            assert (in.senderAddress == s.admin) throw ERR_UNAUTHORIZED;
            var setup = PoolSetup.fromCell(s.setup);
            setup.wiring.set(msg.role, msg.addr);
            s.setup = setup.toCell();
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
// describes. See BounceableMessage for what reaches here and why.
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
        WithdrawPrincipal => {
            // The adapter refused, so the principal never left it and the debit we already
            // committed is wrong. Restore from the journal, not from this message: the
            // bounced body is truncated after 256 bits and its `to` and `amount` are gone,
            // and even intact it never carried joinEpoch. queryId is all we need.
            var s = lazy PoolStorage.load();
            val found = s.pending.get(msg.queryId);
            if (!found.isFound) { return; } // already reclaimed, or a bounce we did not journal
            s.restorePending(msg.queryId, found.loadValue());
            s.save();
        }
        else => {}
    }
}

get fun get_config(): cell {
    val s = lazy PoolStorage.load();
    return PoolSetup.fromCell(s.setup).config;
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
    return eligibleWeight(s.ledger, s.currentEpoch, s.cfg().minHoldEpochs, false);
}
get fun get_odds(who: address): int {
    val s = lazy PoolStorage.load();
    return oddsBps(s.ledger, who, s.currentEpoch, s.cfg().minHoldEpochs);
}
get fun preview_winner(word: uint256): address {
    val s = lazy PoolStorage.load();
    return selectWinner(s.ledger, s.currentEpoch, s.cfg().minHoldEpochs, false, word);
}
// true from AdvanceEpoch (which opens a draw) until that draw's result lands.
// AdvanceEpoch throws ERR_BUSY while set; the keeper reads this to know whether it
// must settle before advancing.
get fun get_draw_open(): bool {
    val s = lazy PoolStorage.load();
    return s.drawOpen;
}
// A withdrawal that has been debited but not yet acked. Non-empty means the adapter
// still owes the payout; an entry that outlives its round trip is a stuck withdrawal
// and the ground truth to restore the ledger from. found=false for an unknown key.
get fun get_pending(queryId: uint64): (address?, coins, EpochId, Timestamp) {
    val s = lazy PoolStorage.load();
    val r = s.pending.get(queryId);
    if (!r.isFound) { return (null, 0, 0, 0); }
    val p = r.loadValue();
    return (p.who, p.amount, p.joinEpoch, p.requestedAt);
}
// Open withdrawals the adapter has not answered. Steady state is 0; a number that
// stays above 0 across epochs is the indexer's signal that something is stuck and a
// reclaim is due. No map size primitive in Tolk, so this iterates like participantCount.
get fun get_pending_count(): int {
    val s = lazy PoolStorage.load();
    var n = 0;
    var r = s.pending.findFirst();
    while (r.isFound) {
        n += 1;
        r = s.pending.iterateNext(r);
    }
    return n;
}
// next queryId RequestWithdraw will assign; also the count of withdrawals ever journaled
get fun get_withdraw_nonce(): uint64 {
    val s = lazy PoolStorage.load();
    return s.withdrawNonce;
}
// the coupled gas budget from "gas", exposed so tests assert against the values the
// contract actually ships rather than hardcoding their own copies
get fun get_gas_budget(): (int, int, int, int) {
    return (SETTLE_GAS, DRAW_RESULT_GAS, PAYOUT_GAS, MAX_PRIZE_TIERS);
}
