/** Text helpers ported from app_examination.py — block splitting, ledger parsing, normalization. */

export const COVERAGE_TAG = "COVERAGE";
export const LEDGER_TAG = "LEDGER";

/**
 * Split a delimited machine-readable block off the end of a model response.
 *
 * Returns { visible, body }. A missing or malformed block yields body "" so a
 * formatting slip degrades the carry-forward rather than the run.
 */
export function splitBlock(text, tag) {
  if (!text) return { visible: "", body: "" };
  const re = new RegExp(
    `<<<\\s*${tag}\\s*>>>([\\s\\S]*?)(?:<<<\\s*END(?:\\s*${tag})?\\s*>>>|$)`,
    "i",
  );
  const match = re.exec(text);
  if (!match) return { visible: text, body: "" };

  const body = match[1]
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n")
    .trim();
  const visible = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { visible, body };
}

/** Best-effort parse of `ID | theme | severity | statement` rows. */
export function parseLedger(body) {
  const rows = [];
  for (const line of (body || "").split("\n")) {
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 4 || !/^C\d+-\d+$/i.test(cells[0])) continue;
    rows.push({
      id: cells[0].toUpperCase(),
      theme: cells[1],
      severity: cells[2],
      issue: cells.slice(3).join(" | "),
    });
  }
  return rows;
}

/**
 * Chapters that referenced an issue raised in a different chapter — the evidence
 * that the de-duplication cascade did its job.
 */
export function recurrenceMap(reviewsByChapter) {
  const hits = new Map();
  for (const [chapter, review] of Object.entries(reviewsByChapter)) {
    const n = Number(chapter);
    if (!review) continue;
    const seen = new Set();
    for (const m of review.matchAll(/\bC(\d+)-(\d+)\b/g)) {
      const id = `C${m[1]}-${m[2]}`;
      if (Number(m[1]) === n || seen.has(id)) continue;
      seen.add(id);
      if (!hits.has(id)) hits.set(id, []);
      hits.get(id).push(n);
    }
  }
  return Object.fromEntries([...hits].map(([k, v]) => [k, v.sort((a, b) => a - b)]));
}

/**
 * Undo PDF line wrapping so the model sees paragraphs rather than ragged lines.
 *
 * Deviates deliberately from _normalize_text in app_examination.py. There the
 * soft-wrap pattern is `(?<!\n\s)\n(?!\s\n)`, whose lookarounds each span two
 * characters and so never fire on a plain blank line. Both newlines in "A\n\nB"
 * are replaced, every paragraph break is lost, and the following `\n\s*\n`
 * cleanup has nothing left to match. Since the examiner is asked to cite
 * sections, tables, and pages, flattening the chapter to a single line removes
 * exactly the structure it needs. Here blank lines are normalized first, then
 * only genuinely isolated newlines are joined.
 */
export function normalizeText(text) {
  if (!text) return "";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(\w+)-\n(\w+)/g, "$1$2") // de-hyphenate across a line break
    .replace(/[ \t]*\n[ \t]*\n[\s]*/g, "\n\n") // blank lines (any padding) become exactly one break
    .replace(/(?<!\n)\n(?!\n)/g, " ") // join soft wraps, leave paragraph breaks intact
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function wordCount(text) {
  return (text || "").split(/\s+/).filter(Boolean).length;
}
