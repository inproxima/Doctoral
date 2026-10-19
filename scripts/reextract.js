#!/usr/bin/env node
/**
 * Re-extract the chapter text of existing runs from the originals in uploads/.
 *
 * Runs created before figures were stripped at extraction carry the base64 payload of
 * every embedded image in their chapter text — one chapter of 87 KB of prose arrived as
 * 1.4 MB and the model rejected the request outright. The originals in uploads/ are
 * untouched, so the text can simply be derived again.
 *
 *   node scripts/reextract.js            # every run
 *   node scripts/reextract.js <run-id>   # one run
 *   node scripts/reextract.js --dry-run  # report only, write nothing
 */
import fs from "node:fs/promises";

import { extractLines, extractText } from "../server/extract.js";
import { wordCount } from "../server/parse.js";
import { splitDocument } from "../server/split.js";
import * as store from "../server/store.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.filter((a) => !a.startsWith("--"));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const runs = only.length ? only : (await store.listRuns()).map((r) => r.id);
if (runs.length === 0) {
  console.log("No runs found.");
  process.exit(0);
}

let changed = 0;

for (const id of runs) {
  const meta = await store.readMeta(id);
  const chapterUploads = (meta.uploads || []).filter((u) => u.chapter && !u.error);
  const documentUploads = (meta.uploads || []).filter((u) => u.kind === "document" && !u.error);
  if (chapterUploads.length === 0 && documentUploads.length === 0) {
    console.log(`${id}: no chapter uploads, skipped`);
    continue;
  }

  console.log(`\n${id}  ${meta.title || "(untitled)"}`);
  const rewritten = [];

  // A complete document is split again, and each chapter it still supplies is re-derived.
  // A chapter only counts when the run still sources it from that document.
  const derived = [];
  for (const u of chapterUploads) {
    const buffer = await fs.readFile(store.uploadPath(id, u.storedAs));
    derived.push({ u, chapter: u.chapter, text: await extractText(u.filename, buffer) });
  }
  for (const u of documentUploads) {
    const buffer = await fs.readFile(store.uploadPath(id, u.storedAs));
    const { chapters } = splitDocument(await extractLines(u.filename, buffer));
    for (const c of chapters) {
      if (meta.chapters?.[c.n]?.uploadId === u.id) derived.push({ u, chapter: c.n, text: c.text });
    }
  }

  for (const { u, chapter, text } of derived) {
    const before = (await store.readArtifact(id, store.ARTIFACT_FILES.chapter(chapter))) || "";

    const delta = before.length - text.length;
    const note = delta > 0 ? `−${kb(delta)}` : delta < 0 ? `+${kb(-delta)}` : "unchanged";
    console.log(
      `  ch${chapter} ${u.filename.padEnd(20)} ${kb(before.length).padStart(10)} → ` +
        `${kb(text.length).padStart(10)}  ${note}`,
    );

    if (delta === 0) continue;
    rewritten.push({ chapter, text });
    if (!dryRun) await store.writeArtifact(id, store.ARTIFACT_FILES.chapter(chapter), text);
  }

  if (rewritten.length === 0 || dryRun) continue;

  await store.updateMeta(id, (m) => {
    for (const { chapter, text } of rewritten) {
      m.chapters[chapter] = { ...(m.chapters[chapter] || {}), words: wordCount(text) };
    }
  });

  // The derived artifacts were produced from, or failed on, the old text. Clearing them
  // makes the next run regenerate rather than resume onto a foundation that no longer exists.
  await store.invalidateDerived(id);
  changed += 1;
  console.log(`  rewritten, derived artifacts cleared — re-run the examination`);
}

console.log(
  dryRun ? "\nDry run: nothing written." : `\n${changed} run(s) rewritten.`,
);
