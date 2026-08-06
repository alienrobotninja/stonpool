import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

// Source comments must describe the code, not the process that produced it. Stage/step and
// plan references go stale the moment the plan moves and mean nothing to someone reading a
// file cold. The file list comes from git, so this sees exactly what a commit can carry and
// never trips over ignored scratch files. Exits non-zero on a hit so it can gate a hook.

const EXT = ['.ts', '.tsx', '.tolk', '.py'];
const LIST = 'git ls-files --cached --others --exclude-standard';

// a bare decimal is a gas value or a version far more often than a plan id, so plan-id only
// counts when a process word shares the line
const PROCESS = /(stage|step|phase|milestone|task)/i;

// each rule is a named pattern so output says WHY a line was flagged
const RULES: { name: string; re: RegExp; needsProcess?: boolean }[] = [
  { name: 'stage-ref', re: /(^|[^a-z])stage\s+\d/i },
  { name: 'step-ref', re: /(^|[^a-z])step\s+\d/i },
  { name: 'branch-step', re: /branch\s+\d+\s+step/i },
  { name: 'handoff-ref', re: /handoff/i },
  { name: 'section-ref', re: /(^|[^a-z])(section|§)\s*\d/i },
  { name: 'plan-id', re: /(^|[^a-z0-9])\d\.\d[a-z]?(-[iv]+)?([^a-z0-9]|$)/i, needsProcess: true },
];

// only comment lines matter; these patterns hit version strings and numbers in code
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/;

export type Hit = { file: string; line: number; rule: string; text: string };

const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8' });

export function listFiles(root: string, exec = run): string[] {
  return exec(LIST, root)
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f !== '' && EXT.some((e) => f.endsWith(e)));
}

export function scanText(text: string): Omit<Hit, 'file'>[] {
  const hits: Omit<Hit, 'file'>[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!COMMENT.test(line)) return; // code lines are not the target
    for (const r of RULES) {
      if (!r.re.test(line)) continue;
      if (r.needsProcess && !PROCESS.test(line)) continue;
      hits.push({ line: i + 1, rule: r.name, text: line.trim() });
      break;
    }
  });
  return hits;
}

function main() {
  const root = resolve(process.argv[2] ?? '.');
  const hits: Hit[] = [];
  for (const file of listFiles(root)) {
    for (const h of scanText(readFileSync(join(root, file), 'utf8'))) hits.push({ file, ...h });
  }

  if (!hits.length) {
    console.log('clean: no process references in comments');
    return;
  }

  let last = '';
  for (const h of hits) {
    if (h.file !== last) {
      console.log(`\n${h.file}`);
      last = h.file;
    }
    console.log(`  ${String(h.line).padStart(4)}  [${h.rule}]  ${h.text.slice(0, 100)}`);
  }
  console.log(`\n${hits.length} reference(s) in ${new Set(hits.map((h) => h.file)).size} file(s)`);
  process.exit(1);
}

if (require.main === module) main();