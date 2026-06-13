from pytoniq_core import begin_cell

# both mirror the on-chain cell.hash() (verified byte-equal against @ton/core):
# the contract commits h256(secret) and mixes the seed as h256(seed, secret).


def commit_hash(secret: int) -> int:
    return int.from_bytes(begin_cell().store_uint(secret, 256).end_cell().hash, "big")


def mix_seed(seed: int, secret: int) -> int:
    cell = begin_cell().store_uint(seed, 256).store_uint(secret, 256).end_cell()
    return int.from_bytes(cell.hash, "big")


def tier_word(seed: int, tier: int) -> int:
    # per-tier draw word: h256(seed || tier:uint32), verified byte-equal against @ton/core.
    cell = begin_cell().store_uint(seed, 256).store_uint(tier, 32).end_cell()
    return int.from_bytes(cell.hash, "big")
