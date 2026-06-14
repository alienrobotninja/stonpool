import { Address, Cell } from "@ton/core";

import {
  OP_DEPOSIT,
  OP_FAUCET_REQUEST,
  OP_JETTON_TRANSFER,
  OP_REQUEST_WITHDRAW,
  buildFaucetClaim,
  buildJettonDeposit,
  buildWithdraw,
} from "./messages";

const POOL = "0:" + "aa".repeat(32);
const USER = "0:" + "bb".repeat(32);

test("buildFaucetClaim encodes the op and queryId", () => {
  const s = Cell.fromBase64(buildFaucetClaim(7)).beginParse();
  expect(s.loadUint(32)).toBe(OP_FAUCET_REQUEST);
  expect(s.loadUint(64)).toBe(7);
});

test("buildJettonDeposit lays out a TEP-74 transfer with an OP_DEPOSIT payload", () => {
  const s = Cell.fromBase64(
    buildJettonDeposit({ amount: 5_000_000n, poolCore: POOL, user: USER, queryId: 1 }),
  ).beginParse();
  expect(s.loadUint(32)).toBe(OP_JETTON_TRANSFER);
  expect(s.loadUint(64)).toBe(1);
  expect(s.loadCoins()).toBe(5_000_000n);
  expect(s.loadAddress().toRawString()).toBe(Address.parseRaw(POOL).toRawString());
  expect(s.loadAddress().toRawString()).toBe(Address.parseRaw(USER).toRawString()); // excesses
  expect(s.loadMaybeRef()).toBeNull(); // customPayload
  s.loadCoins(); // forwardTonAmount
  expect(s.loadUint(32)).toBe(OP_DEPOSIT);
  expect(s.loadAddress().toRawString()).toBe(Address.parseRaw(USER).toRawString()); // depositor
});

test("buildWithdraw encodes RequestWithdraw", () => {
  const s = Cell.fromBase64(buildWithdraw(3_000_000n, 2)).beginParse();
  expect(s.loadUint(32)).toBe(OP_REQUEST_WITHDRAW);
  expect(s.loadUint(64)).toBe(2);
  expect(s.loadCoins()).toBe(3_000_000n);
});