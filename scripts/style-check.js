#!/usr/bin/env node
/**
 * Verify generated artifacts obey the house writing style.
 *
 * The style forbids colons, semicolons, and dashes, but the examiner output format
 * is built on all three. This script strips the scaffolding the style exempts —
 * headings, table rows, bold field labels, issue IDs, code fences — and checks only
 * what is left, which is the prose the rules actually bind.
 *
 * Usage: npm run style-check runs/<run-id>
 *        npm run style-check path/to/file.md
 */
import fs from "node:fs/promises";
import path from "node:path";

const PROSE_VIOLATIONS = [
  { name: "colon", re: /:(?!\/\/)/ },
  { name: "semicolon", re: /;/ },
  { name: "em dash", re: /—/ },
  { name: "en dash", re: /–/ },
  { name: "hyphen used as a dash", re: /\s-{1,2}\s/ },
];

/** Lines the SCAFFOLDING EXEMPTION in server/style.js covers. */
function isScaffolding(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith("#")) return true; // headings
  if (t.startsWith("|")) return true; // table rows and separators
  if (t.startsWith("```")) return true; // code fences
  if (/^<<</.test(t)) return true; // machine-readable blocks
  if (/^\[?C\d+-\d+\]?/.test(t)) return true; // ledger rows and recurrence references
  if (/^-\s+\*\*(Critical|Major|Moderate|Minor)\*\*/.test(t)) return true; // severity scale
  return false;
}

/**
 * A bullet like `- **Where:** §3.4, p.62` is scaffolding up to and including the
 * label colon. Strip the label, keep the prose that follows.
 */
function proseOf(line) {
  let t = line.trim();
  t = t.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
  const label = /^\*\*[^*]+:\*\*\s*/.exec(t);
  if (label) t = t.slice(label[0].length);
  return t;
}

async function collectFiles(target) {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const out = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath || entry.path, entry.name);
    if (/\.(md|txt)$/.test(entry.name) && !full.includes("/chapters/")) out.push(full);
  }
  return out;
}

async function checkFile(file) {
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n");
  const issues = [];
  let quotes = 0;

  lines.forEach((line, i) => {
    quotes += (line.match(/["“”]/g) || []).length;
    if (isScaffolding(line)) return;
    const prose = proseOf(line);
    if (!prose) return;

    // Quoted spans are the candidate's words, not the examiner's, so punctuation
    // inside them is not a style violation.
    const unquoted = prose.replace(/"[^"]*"/g, "").replace(/[“][^”]*[”]/g, "");

    for (const { name, re } of PROSE_VIOLATIONS) {
      if (re.test(unquoted)) {
        issues.push({ line: i + 1, name, text: prose.slice(0, 110) });
      }
    }
  });

  return { file, issues, quotes: Math.floor(quotes / 2) };
}

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run style-check <run-dir-or-file>");
  process.exit(2);
}

const files = await collectFiles(target);
if (files.length === 0) {
  console.error(`No .md or .txt artifacts found under ${target}`);
  process.exit(2);
}

let total = 0;
for (const file of files) {
  const { issues, quotes } = await checkFile(file);
  total += issues.length;
  const rel = path.relative(process.cwd(), file);
  if (issues.length === 0) {
    console.log(`✅ ${rel}  (${quotes} quoted span${quotes === 1 ? "" : "s"})`);
  } else {
    console.log(`❌ ${rel}  ${issues.length} prose violation${issues.length === 1 ? "" : "s"}`);
    for (const v of issues.slice(0, 12)) {
      console.log(`     line ${v.line}  ${v.name}  →  ${v.text}`);
    }
    if (issues.length > 12) console.log(`     … and ${issues.length - 12} more`);
  }
  // coverage/ and ledger/ are machine-readable blocks by design (criterion titles,
  // pipe-delimited rows), so the quotation requirement does not apply to them.
  const isProseArtifact = !/\/(coverage|ledger)\//.test(file);
  if (isProseArtifact && quotes === 0) {
    console.log(`   ⚠️  no direct quotation found in ${rel}`);
  }
}

console.log(
  `\n${files.length} file${files.length === 1 ? "" : "s"} checked, ${total} prose violation${
    total === 1 ? "" : "s"
  }.`,
);
process.exit(total === 0 ? 0 : 1);
