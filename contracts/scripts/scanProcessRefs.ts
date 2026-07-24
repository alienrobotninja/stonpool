import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

// Source comments must describe the code, not the process that produced it. Stage/step,
// handoff and section references go stale the moment the plan moves and mean nothing to
// someone reading the file cold. Run from the repo root; exits non-zero if any are found
// so it can gate a commit hook.

const ROOT = resolve(process.argv[2] ?? '.');
const EXT = ['.ts', '.tsx', '.tolk', '.py', '.md'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'venv', '.venv', '__pycache__']);

// each rule is a named pattern so output says WHY a line was flagged
const RULES: { name: string; re: RegExp }[] = [
  { name: 'stage-ref', re: /(^|[^a-z])stage\s+\d/i },
  { name: 'step-ref', re: /(^|[^a-z])step\s+\d/i },
  { name: 'branch-step', re: /branch\s+\d+\s+step/i },
  { name: 'handoff-ref', re: /handoff/i },
  { name: 'section-ref', re: /(^|[^a-z])(section|§)\s*\d/i },
  { name: 'plan-id', re: /(^|[^a-z0-9])\d\.\d[a-z]?(-[iv]+)?([^a-z0-9]|$)/i },
];

// only comment lines matter; a plan-id pattern hits version strings and numbers in code
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/;

type Hit = { file: string; line: number; rule: string; text: string };
const hits: Hit[] = [];

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!EXT.some((e) => name.endsWith(e))) continue;
    const isMd = name.endsWith('.md');
    readFileSync(p, 'utf8').split(/\r?\n/).forEach((text, i) => {
      if (!isMd && !COMMENT.test(text)) return; // code lines are not the target
      for (const r of RULES) {
        if (r.re.test(text)) { hits.push({ file: relative(ROOT, p), line: i + 1, rule: r.name, text: text.trim() }); break; }
      }
    });
  }
}

walk(ROOT);

if (!hits.length) { console.log('clean: no process references in comments'); process.exit(0); }

let last = '';
for (const h of hits) {
  if (h.file !== last) { console.log(`\n${h.file}`); last = h.file; }
  console.log(`  ${String(h.line).padStart(4)}  [${h.rule}]  ${h.text.slice(0, 100)}`);
}
console.log(`\n${hits.length} reference(s) in ${new Set(hits.map((h) => h.file)).size} file(s)`);
process.exit(1);