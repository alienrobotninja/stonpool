import { listFiles, scanText } from '../scripts/scanProcessRefs';

// The rules ran at a 100% false-positive rate before this: every hit in the tree was a gas
// value, a version string or a runbook heading, and the scanner even flagged itself. These
// pin the two halves that were wrong - what counts as a plan id, and where files come from.
describe('process reference scan', () => {
  it('leaves gas values alone', () => {
    expect(scanText('//   1. DRAW_RESULT_GAS (0.5) could not fund the payout loop')).toEqual([]);
  });

  it('leaves version strings alone', () => {
    expect(scanText('// wallet patched for Tolk 1.4.x')).toEqual([]);
  });

  it('flags a plan id when a process word shares the line', () => {
    expect(scanText('// deferred to task 4.2').map((h) => h.rule)).toEqual(['plan-id']);
  });

  it('flags stage and step references', () => {
    expect(scanText('// wired up in stage 4').map((h) => h.rule)).toEqual(['stage-ref']);
    expect(scanText('# see step 2 for the reseed').map((h) => h.rule)).toEqual(['step-ref']);
  });

  it('ignores anything outside a comment', () => {
    expect(scanText("const label = 'stage 4';")).toEqual([]);
  });

  it('takes the file list from git and keeps only source files', () => {
    let cmd = '';
    const files = listFiles('.', (c) => {
      cmd = c;
      return 'a.ts\nnotes.md\nb.tolk\nc.py\n\n';
    });
    expect(cmd).toBe('git ls-files --cached --others --exclude-standard');
    expect(files).toEqual(['a.ts', 'b.tolk', 'c.py']);
  });
});