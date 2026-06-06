// C3 draw-engine: bonded commit-reveal producing a verifiable per-epoch seed.
// S3 covers storage + draw start + the commit phase; reveal/finalize follow.
import "shared"
import "draw_messages"

const ERR_ALREADY_COMMITTED = 435
const ERR_ALREADY_REVEALED = 436

struct CommitState {
    commitHash: uint256
    bond: coins
    revealed: bool
}

// poolCore + windows/bond config + per-epoch draw state + the commit set.
@overflow1023_policy("suppress")
struct DrawStorage {
    poolCore: address
    epoch: EpochId
    commitWindow: uint32
    revealWindow: uint32
    drawBond: coins
    commitDeadline: uint32
    revealDeadline: uint32
    finalized: bool
    seed: uint256
    commits: map<address, CommitState>
}

fun DrawStorage.load() { return DrawStorage.fromCell(contract.getData()) }
fun DrawStorage.save(self) { contract.setData(self.toCell()) }

type AllowedMessage = StartDraw | Commit | Reveal

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } // deploy
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        StartDraw => {
            var s = lazy DrawStorage.load();
            assert (in.senderAddress == s.poolCore) throw ERR_UNAUTHORIZED;
            val nowTs = blockchain.now() as uint32;
            s.epoch = msg.epoch;
            s.commitDeadline = nowTs + s.commitWindow;
            s.revealDeadline = s.commitDeadline + s.revealWindow;
            s.finalized = false;
            s.seed = 0;
            s.commits = createEmptyMap<address, CommitState>();
            s.save();
        }

        Commit => {
            var s = lazy DrawStorage.load();
            val nowTs = blockchain.now() as uint32;
            assert (s.commitDeadline != 0 && nowTs < s.commitDeadline) throw ERR_NOT_COMMIT_WINDOW;
            assert (in.valueCoins >= s.drawBond) throw ERR_INSUFFICIENT_BOND;
            assert (!s.commits.exists(in.senderAddress)) throw ERR_ALREADY_COMMITTED;
            val cs: CommitState = { commitHash: msg.commitHash, bond: in.valueCoins, revealed: false };
            s.commits.set(in.senderAddress, cs);
            s.save();
        }

        Reveal => {
            var s = lazy DrawStorage.load();
            val nowTs = blockchain.now() as uint32;
            assert (s.commitDeadline != 0 && nowTs >= s.commitDeadline && nowTs < s.revealDeadline) throw ERR_NOT_REVEAL_WINDOW;
            val found = s.commits.get(in.senderAddress);
            assert (found.isFound) throw ERR_NO_COMMIT;
            var cs = found.loadValue();
            assert (!cs.revealed) throw ERR_ALREADY_REVEALED;
            val computed = beginCell().storeUint(msg.secret, 256).endCell().hash();
            assert (computed == cs.commitHash) throw ERR_BAD_REVEAL;
            // fold the secret into the running seed; verifiable off-chain as hash(seed || secret)
            s.seed = beginCell().storeUint(s.seed, 256).storeUint(msg.secret, 256).endCell().hash();
            cs.revealed = true;
            s.commits.set(in.senderAddress, cs);
            s.save();
            createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: cs.bond }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        else => {
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_OP
        }
    }
}

get fun get_draw_state(): (EpochId, uint32, uint32, bool, uint256) {
    val s = lazy DrawStorage.load();
    return (s.epoch, s.commitDeadline, s.revealDeadline, s.finalized, s.seed);
}

get fun get_commit(who: address): (uint256, coins, bool) {
    val s = lazy DrawStorage.load();
    val r = s.commits.get(who);
    if (!r.isFound) { return (0, 0, false); }
    val cs = r.loadValue();
    return (cs.commitHash, cs.bond, cs.revealed);
}
