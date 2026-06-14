import { Cell } from "@ton/core";

import { OP_FAUCET_REQUEST, buildFaucetClaim } from "./messages";

test("buildFaucetClaim encodes the op and queryId", () => {
  const s = Cell.fromBase64(buildFaucetClaim(7)).beginParse();
  expect(s.loadUint(32)).toBe(OP_FAUCET_REQUEST);
  expect(s.loadUint(64)).toBe(7);
});