from pytoniq_core import Address, Cell, begin_cell

OP_ADVANCE_EPOCH = 0x10000004
OP_COMMIT = 0x10000011
OP_REVEAL = 0x10000012
OP_SETTLE_DRAW = 0x10000016
OP_HARVEST_STONFI = 0x10000035


def build_advance_epoch(query_id: int = 0) -> Cell:
    return begin_cell().store_uint(OP_ADVANCE_EPOCH, 32).store_uint(query_id, 64).end_cell()


def build_settle_draw(query_id: int = 0) -> Cell:
    return begin_cell().store_uint(OP_SETTLE_DRAW, 32).store_uint(query_id, 64).end_cell()


def build_commit(commit_hash: int, query_id: int = 0) -> Cell:
    return (
        begin_cell()
        .store_uint(OP_COMMIT, 32)
        .store_uint(query_id, 64)
        .store_uint(commit_hash, 256)
        .end_cell()
    )


def build_reveal(secret: int, query_id: int = 0) -> Cell:
    return (
        begin_cell()
        .store_uint(OP_REVEAL, 32)
        .store_uint(query_id, 64)
        .store_uint(secret, 256)
        .end_cell()
    )


def build_harvest_stonfi(*, lp_to_burn: int, gross_yield: int, to: str, query_id: int = 0) -> Cell:
    return (
        begin_cell()
        .store_uint(OP_HARVEST_STONFI, 32)
        .store_uint(query_id, 64)
        .store_coins(lp_to_burn)
        .store_coins(gross_yield)
        .store_address(Address(to))
        .end_cell()
    )
