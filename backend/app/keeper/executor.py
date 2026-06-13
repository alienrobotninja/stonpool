from dataclasses import replace

from sqlalchemy.ext.asyncio import AsyncSession

from app.clients.chain import ChainClient
from app.clients.sources import read_preview_winner
from app.core.config import Settings, get_settings
from app.keeper.hashing import mix_seed, tier_word
from app.keeper.planner import Action, KeeperState, Phase, plan
from app.keeper.secrets import SecretStore, from_hex, gen_secret, to_hex
from app.keeper.sender import TxSender
from app.repositories import EventRepo, StateRepo


class Keeper:
    # drives one tick: resolves the secret for commit/reveal, runs the pure planner,
    # broadcasts via the sender, and records the settlement from the seed it controls.
    # build_state (chain -> KeeperState incl phase) is wired in the runtime entrypoint;
    # it is not unit-tested here since it depends on live chain reads.
    def __init__(
        self,
        client: ChainClient,
        sender: TxSender,
        db: AsyncSession,
        cfg: Settings | None = None,
    ):
        self.client = client
        self.sender = sender
        self.db = db
        self.cfg = cfg or get_settings()
        self.secrets = SecretStore(db)
        self.state = StateRepo(db)
        self.events = EventRepo(db)

    async def tick(self, state: KeeperState) -> list[str]:
        state = await self._prepare_secret(state)
        sent: list[str] = []
        for action in plan(state, self.cfg):
            tx = await self.sender.send(to=action.to, body=action.body, value=action.value)
            sent.append(tx)
            await self._after_send(action, state, tx)
        return sent

    async def _prepare_secret(self, state: KeeperState) -> KeeperState:
        if state.phase is Phase.COMMIT and state.commit_hash is None:
            row = await self.secrets.create(epoch=state.epoch, secret=gen_secret())
            return replace(state, commit_hash=from_hex(row.commit_hash))
        if state.phase is Phase.REVEAL and state.reveal_secret is None:
            row = await self.secrets.get(state.epoch)
            if row is not None:
                return replace(state, reveal_secret=from_hex(row.secret))
        return state

    async def _after_send(self, action: Action, state: KeeperState, tx: str) -> None:
        if action.kind == "reveal":
            await self.secrets.mark_revealed(state.epoch)
        elif action.kind == "settle":
            await self._record_settlement(state, tx)

    async def _record_settlement(self, state: KeeperState, settle_tx: str) -> None:
        pot = state.prize_pot
        skim = pot * self.cfg.skim_bps // 10000
        distributable = pot - skim
        eligible = await self.state.list_positions(eligible_only=True)
        tiers = min(self.cfg.prize_tiers, len(eligible))

        row = await self.secrets.get(state.epoch)
        seed = mix_seed(0, from_hex(row.secret)) if row is not None else 0

        await self.state.upsert_draw(
            epoch=state.epoch,
            seed=to_hex(seed),
            distributable=distributable,
            skim=skim,
            num_winners=tiers,
            settled_ts=state.now,
            settle_tx=settle_tx,
        )
        if tiers == 0:
            return

        per_tier = distributable // tiers
        remainder = distributable - per_tier * tiers
        chosen: set[str] = set()
        for tier in range(tiers):
            winner = await read_preview_winner(
                self.client, self.cfg.pool_core_address, tier_word(seed, tier)
            )
            if winner in chosen:
                continue  # on-chain picks a distinct winner; indexer reconciles from transfers
            chosen.add(winner)
            await self.events.add_payout(
                tx_hash=f"draw:{state.epoch}:{tier}",
                lt=state.now,
                ts=state.now,
                winner=winner,
                amount=per_tier + (remainder if tier == 0 else 0),
                tier=tier,
                epoch=state.epoch,
            )
