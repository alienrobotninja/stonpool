// C3 draw-engine message surface. The commit bond is carried as the message
// value, not a struct field.
import "shared"

// pool-core -> draw-engine: open a new draw for `epoch` (sets commit/reveal windows).
struct (0x10000013) StartDraw {
    queryId: uint64
    epoch: EpochId
}

// participant -> draw-engine: bonded commitment to hash(secret).
struct (0x10000011) Commit {
    queryId: uint64
    commitHash: uint256
}

// participant -> draw-engine: reveal the secret; verified against the commit and
// mixed into the running seed.
struct (0x10000012) Reveal {
    queryId: uint64
    secret: uint256
}

// draw-engine -> pool-core: finalized verifiable randomness for the epoch.
struct (0x10000014) DrawResultMsg {
    queryId: uint64
    result: DrawResult
}
