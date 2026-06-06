// Test fixture for C2: holds a sample ledger, exposes the selection + demo
// read-methods. Mirrors how pool-core (C1) will surface them. Not deployed.
import "shared"
import "selection"

struct TesterStorage {
    currentEpoch: EpochId
    minHoldEpochs: uint16
    ledger: map<address, LedgerEntry>
}

fun TesterStorage.load() { return TesterStorage.fromCell(contract.getData()) }
fun TesterStorage.save(self) { contract.setData(self.toCell()) }

struct (0x7e570001) AddEntry {
    queryId: uint64
    who: address
    weight: coins
    joinEpoch: EpochId
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; } // deploy
    val msg = lazy AddEntry.fromSlice(in.body);
    var storage = lazy TesterStorage.load();
    val entry: LedgerEntry = { weight: msg.weight, joinEpoch: msg.joinEpoch };
    storage.ledger.set(msg.who, entry);
    storage.save();
}

get fun get_participant_count(): int {
    val s = lazy TesterStorage.load();
    return participantCount(s.ledger);
}
get fun get_total_weight(): coins {
    val s = lazy TesterStorage.load();
    return eligibleWeight(s.ledger, s.currentEpoch, s.minHoldEpochs, false);
}
get fun get_odds(who: address): int {
    val s = lazy TesterStorage.load();
    return oddsBps(s.ledger, who, s.currentEpoch, s.minHoldEpochs);
}
get fun preview_winner(word: uint256): address {
    val s = lazy TesterStorage.load();
    return selectWinner(s.ledger, s.currentEpoch, s.minHoldEpochs, false, word);
}
get fun preview_winner_flat(word: uint256): address {
    val s = lazy TesterStorage.load();
    return selectWinner(s.ledger, s.currentEpoch, s.minHoldEpochs, true, word);
}
get fun tier_word(seed: uint256, tier: int): uint256 {
    return tierWord(seed, tier);
}
