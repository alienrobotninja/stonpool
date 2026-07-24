import { derivePlayers, operatorAddress, WEIGHTS } from '../scripts/demoPlayers';

// The seeder credits these addresses as deposit beneficiaries. A wrong derivation credits
// positions nobody holds keys for - the jettons are not lost, but they can never be
// withdrawn, and the no-loss demonstration quietly becomes impossible. Cheap to pin.

const PK = Buffer.alloc(32, 7); // any fixed key; derivation must not depend on its value

describe('demo player derivation', () => {
  it('gives one distinct address per weight, none of them the operator', () => {
    const players = derivePlayers(PK);
    expect(players).toHaveLength(WEIGHTS.length);
    expect(new Set(players.map((a) => a.toRawString())).size).toBe(WEIGHTS.length);

    // subwallet 0 is the operator itself, so the field must start at 1 or the operator
    // would be seeded as one of its own players and double-counted in the odds
    const operator = operatorAddress(PK);
    expect(players.some((a) => a.equals(operator))).toBe(false);
  });

  it('is deterministic, so a re-run addresses the same field', () => {
    expect(derivePlayers(PK).map((a) => a.toRawString()))
      .toEqual(derivePlayers(PK).map((a) => a.toRawString()));
  });

  it('spreads weight unevenly so odds are visibly different', () => {
    expect(new Set(WEIGHTS).size).toBeGreaterThan(WEIGHTS.length / 2);
    const total = WEIGHTS.reduce((a, b) => a + b, 0n);
    expect(total).toBeLessThanOrEqual(1000n); // one faucet drip, minus room for the yield
    // the largest stake must not dominate, or one player wins effectively every draw
    expect(WEIGHTS.reduce((m, x) => (x > m ? x : m), 0n) * 4n).toBeLessThan(total);
  });
});