// Checks site/css/style.css against the mechanical rules in STYLE.md:
// font sizes and weights from the type scale, spacing from the spacing scale,
// and no hard-coded colours outside the :root token blocks.
// Usage: node scripts/style-lint.mjs [--all]   (default: summary + first 40 findings)
import fs from "node:fs";

const css = fs.readFileSync(new URL("../site/css/style.css", import.meta.url), "utf8");
const lines = css.split("\n");

const FONT = new Set([12, 13, 15, 18, 20, 24, 32, 56]);
const WEIGHT = new Set([400, 600, 800]);
const SPACE = new Set([0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64]); // 1-2px allowed for hairline nudges

// token blocks (:root and theme overrides) are where colours are defined
let inTokens = 0;
const findings = [];
const add = (rule, i, msg) => findings.push({ rule, line: i + 1, msg, text: lines[i].trim().slice(0, 110) });

lines.forEach((l, i) => {
  if (/^\s*:root|^\s*@media \(prefers-color-scheme/.test(l) && /\{\s*$/.test(l)) inTokens++;
  if (inTokens && /^\s*}\s*$/.test(l)) inTokens = Math.max(0, inTokens - 1);
  const code = l.replace(/\/\*.*?\*\//g, "");
  for (const m of code.matchAll(/font-size:\s*([\d.]+)px/g)) if (!FONT.has(+m[1])) add("font-size", i, `${m[1]}px not in type scale`);
  for (const m of code.matchAll(/font-weight:\s*(\d+)/g)) if (!WEIGHT.has(+m[1])) add("font-weight", i, `${m[1]} not in 400/600/800`);
  for (const m of code.matchAll(/(?:^|[;{\s])(?:margin|padding|gap|row-gap|column-gap)(?:-[a-z]+)?:\s*([^;}]+)/g)) {
    for (const v of m[1].matchAll(/(-?[\d.]+)px/g)) if (!SPACE.has(Math.abs(+v[1]))) add("spacing", i, `${v[1]}px not in spacing scale`);
  }
  if (!inTokens && !/--[\w-]+\s*:/.test(code)) {
    for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
      if (/^rgba?\(0,\s*0,\s*0/.test(m[0])) continue; // black shadows are fine
      add("colour", i, `hard-coded ${m[0]} (use a token)`);
    }
  }
});

const by = findings.reduce((a, f) => ((a[f.rule] = (a[f.rule] ?? 0) + 1), a), {});
const sizes = [...new Set([...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => +m[1]))].sort((a, b) => a - b);
console.log(`STYLE.md lint: ${findings.length} findings`, by);
console.log(`distinct font sizes in use: ${sizes.length} (${sizes.join(", ")}) — target ${FONT.size}`);
for (const f of process.argv.includes("--all") ? findings : findings.slice(0, 40)) console.log(`  ${f.rule.padEnd(11)} L${f.line}: ${f.msg}  |  ${f.text}`);
if (!process.argv.includes("--all") && findings.length > 40) console.log(`  … ${findings.length - 40} more (--all to list)`);
process.exitCode = 0; // report only for now; flip to failing once the first design pass lands
