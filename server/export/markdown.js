/**
 * Markdown into the small block model both exporters render from.
 *
 * marked does the parsing, since the examiner output leans on everything a hand-rolled
 * parser gets wrong: tables, loose lists whose items carry a second paragraph ("Follow
 * up." under an oral question), nesting, and emphasis inside headings. The Word and PDF
 * renderers then only ever see headings, paragraphs, lists, tables, quotes and rules,
 * with inline text flattened into styled runs.
 */
import { Lexer } from "marked";

/**
 * Emoji are section markers in the app and noise in a formal document, and the embedded
 * PDF fonts have no glyphs for them. A pictograph followed by U+FE0F (⚠️, ✏️, 🗣️) is
 * removed with its selector; ©, ™ and arrows, which are pictographic only in their emoji
 * presentation, survive.
 */
const EMOJI = /\p{Extended_Pictographic}️|\p{Emoji_Presentation}|[‍️⃣]|[\u{1F3FB}-\u{1F3FF}]/gu;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

export const stripEmoji = (s) => String(s || "").replace(EMOJI, "");

const decode = (s) =>
  String(s || "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const stripTags = (s) => decode(String(s || "").replace(/<[^>]*>/g, ""));

export function parseMarkdown(src) {
  return blocks(new Lexer({ gfm: true }).lex(String(src || "")));
}

function blocks(tokens) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === "heading") {
      const runs = inlines(t.tokens);
      if (plain(runs)) out.push({ type: "heading", depth: t.depth, runs });
    } else if (t.type === "paragraph" || t.type === "text") {
      const runs = t.tokens ? inlines(t.tokens) : clean([{ text: decode(t.text) }]);
      if (plain(runs)) out.push({ type: "paragraph", runs });
    } else if (t.type === "list") {
      out.push({
        type: "list",
        ordered: t.ordered,
        start: Number(t.start) || 1,
        items: t.items.map((item) => blocks(item.tokens)),
      });
    } else if (t.type === "table") {
      out.push({
        type: "table",
        header: t.header.map((cell) => inlines(cell.tokens)),
        rows: t.rows.map((row) => row.map((cell) => inlines(cell.tokens))),
      });
    } else if (t.type === "blockquote") {
      out.push({ type: "quote", blocks: blocks(t.tokens) });
    } else if (t.type === "code") {
      if (t.text.trim()) out.push({ type: "code", text: stripEmoji(t.text) });
    } else if (t.type === "hr") {
      out.push({ type: "rule" });
    } else if (t.type === "html") {
      const text = stripTags(t.text).trim();
      if (text) out.push({ type: "paragraph", runs: clean([{ text }]) });
    }
    // space and def tokens carry nothing to render
  }
  return out;
}

function inlines(tokens, style = {}) {
  const runs = [];
  for (const t of tokens || []) {
    if (t.type === "strong") runs.push(...inlines(t.tokens, { ...style, bold: true }));
    else if (t.type === "em") runs.push(...inlines(t.tokens, { ...style, italic: true }));
    else if (t.type === "del") runs.push(...inlines(t.tokens, { ...style, strike: true }));
    else if (t.type === "link") runs.push(...inlines(t.tokens, { ...style, link: t.href }));
    else if (t.type === "br") runs.push({ ...style, text: "\n" });
    else if (t.type === "html") runs.push({ ...style, text: stripTags(t.text) });
    else if (t.type === "image") runs.push({ ...style, text: t.text || "" });
    // Backticks in this output are mostly the prompt's own quoting echoed back
    // (`Not applicable. …`, `—`), so they render as ordinary text, not as code.
    else if (t.type === "codespan") runs.push({ ...style, text: decode(t.text) });
    else if (t.type === "text" && t.tokens) runs.push(...inlines(t.tokens, style));
    else if (t.text !== undefined) runs.push({ ...style, text: decode(t.text) });
  }
  return clean(runs);
}

const sameStyle = (a, b) =>
  Boolean(a.bold) === Boolean(b.bold) &&
  Boolean(a.italic) === Boolean(b.italic) &&
  Boolean(a.strike) === Boolean(b.strike) &&
  a.link === b.link;

/** Strip emoji, collapse the space they leave behind, and merge runs that share a style. */
function clean(runs) {
  const merged = [];
  for (const run of runs) {
    const text = stripEmoji(run.text).replace(/[ \t]{2,}/g, " ");
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && sameStyle(last, run)) last.text += text;
    else merged.push({ ...run, text });
  }
  if (merged.length) {
    merged[0].text = merged[0].text.replace(/^\s+/, "");
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, "");
  }
  return merged.filter((r) => r.text);
}

export const plain = (runs) => (runs || []).map((r) => r.text).join("");

// ---------- examiner-specific structure ----------

export const SEVERITIES = ["Critical", "Major", "Moderate", "Minor"];
const SEVERITY_WORD = /^(critical|major|moderate|minor)$/i;
const ID = /^(C\d+-\d+|\d+\.)$/i;
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * Split an issue heading into its parts so the severity can be drawn as a badge.
 *
 * The model writes the same heading several ways across runs: `C2-01 · Major Title`,
 * `C2-01 · **Major** Title`, and in the final review `1. [Critical] Title` or
 * `1. Critical · Title`. A bare severity word is only taken as one when an issue ID
 * precedes it, so a title that merely begins with "Major" is never mistaken for a rating. Anything else is an
 * ordinary heading and returns null.
 */
export function issueHeading(runs) {
  const text = plain(runs);
  const bracketed = /^\s*(C\d+-\d+|\d+\.)?\s*[·:–—-]?\s*\[(critical|major|moderate|minor)\]\s*[·:–—-]?\s*(.*)$/i.exec(text);
  if (bracketed) return { id: bracketed[1] || "", severity: titleCase(bracketed[2]), title: bracketed[3].trim() };

  const bare = /^\s*(C\d+-\d+|\d+\.)\s*[·:–—-]?\s*(critical|major|moderate|minor)\b\s*[·:–—-]?\s*(.+)$/i.exec(text);
  if (bare) return { id: bare[1], severity: titleCase(bare[2]), title: bare[3].trim() };

  const i = runs.findIndex((r) => r.bold && SEVERITY_WORD.test(r.text.trim()));
  if (i < 0) return null;
  const before = plain(runs.slice(0, i)).replace(/[\s·:–—-]+$/, "").trim();
  if (before && !ID.test(before)) return null;
  return {
    id: before,
    severity: titleCase(runs[i].text.trim()),
    title: plain(runs.slice(i + 1)).replace(/^[\s·:–—-]+/, "").trim(),
  };
}

/**
 * A paragraph or list item that opens with a bold label such as **Where:** gets the label
 * styled as a field name, which is what makes a Point to Consider scannable on paper.
 */
export const isFieldLabel = (run) => Boolean(run?.bold && /:\s*$/.test(run.text) && run.text.length <= 40);

/** Proportional column widths from the text each column actually holds, floored so no column collapses. */
export function columnWeights(table, floor = 0.08) {
  const columns = table.header.length;
  const lengths = Array.from({ length: columns }, (_, j) => {
    const cells = [table.header[j], ...table.rows.map((r) => r[j])].filter(Boolean);
    const total = cells.reduce((s, c) => s + plain(c).length, 0);
    return Math.max(4, Math.min(120, total / Math.max(1, cells.length)));
  });
  const sum = lengths.reduce((a, b) => a + b, 0);
  let weights = lengths.map((l) => Math.max(floor, l / sum));
  const norm = weights.reduce((a, b) => a + b, 0);
  weights = weights.map((w) => w / norm);
  return weights;
}
