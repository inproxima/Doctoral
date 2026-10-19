/**
 * Find the chapters inside a complete proposal or dissertation.
 *
 * The upload is the whole document as the candidate submitted it: title page, abstract,
 * table of contents, the chapters, references and appendices. Only the chapters are
 * examined, so the job here is to find where each one starts and where the last one stops.
 *
 * A chapter starts at a heading. Most documents label it ("Chapter 2", "CHAPTER TWO",
 * "Chapter II: Literature Review"), so those are looked for first. The same label also
 * turns up where it is not a chapter start, and each case is handled on its own terms:
 *
 *   table of contents     a run of labels with almost no text between them
 *   running headers       the same label repeated at the top of every page of the chapter
 *   the chapter 1 roadmap "Chapter 2 reviews the literature", a sentence and not a heading
 *
 * Labels are grouped into runs of the same chapter number, and each chapter takes the run
 * with the most text behind it. A table of contents loses to the chapter it lists, and a
 * running header joins the run its chapter opened. Sentences are refused outright: in a
 * heading, what follows the number is punctuation, a capitalised title, or nothing.
 *
 * Documents whose chapter numbers come from Word's list numbering have no label in their
 * text at all. For those the fallback is the top-level headings themselves.
 *
 * The last chapter ends at the back matter (references, appendices), and everything before
 * the first chapter is front matter. Both are reported so the split can be checked.
 */
import { finishText } from "./extract.js";
import { wordCount } from "./parse.js";

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

const CHAPTER_LABEL =
  /^chapter\s+(\d{1,2}|[ivx]{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\s*[:.\-–—]?\s*(.*)$/i;

const REFERENCES = /^(references|reference list|bibliography|works cited|literature cited)\b/i;
const BACK_MATTER = /^(references|reference list|bibliography|works cited|literature cited|appendix|appendices)\b/i;

const FRONT_MATTER =
  /^(abstract|acknowledge?ments?|dedication|preface|(table of )?contents|list of (tables|figures|abbreviations|acronyms|appendices)|glossary|abbreviations|copyright|approval|signature|declaration)\b/i;

/** The usual chapter titles, in the order a thesis presents them, for documents with no labels. */
const CHAPTER_NAMES = [
  /^introduction\b/i,
  /^(literature review|review of (the )?(related |relevant )?literature|theoretical (framework|background)|conceptual framework)\b/i,
  /^((research )?methodology|(research )?methods?|research design|method and design)\b/i,
  /^(results|findings|data analysis|analysis and results|presentation of (the )?(data|findings|results))\b/i,
  /^discussion\b/i,
  /^(conclusions?|summary,? conclusions?|summary and conclusions?|implications|recommendations)\b/i,
];

/** Minimum words a chapter must hold to count as one rather than a stray label. */
const MIN_CHAPTER_WORDS = 120;

function numberOf(token) {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] || ROMAN[t] || null;
}

/** A line as a heading would read once its Markdown, anchors and emphasis are set aside. */
function bare(text) {
  return String(text || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/<a\b[^>]*>\s*<\/a>/gi, "")
    .replace(/\*\*|__/g, "")
    .replace(/^[*_\s]+|[*_\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (s) => (s.match(/\S+/g) || []).length;

/**
 * Entries in a table of contents carry a page number after the title, often behind dot
 * leaders or a tab. Word's own contents field arrives from mammoth as an internal link.
 */
function looksLikeContentsEntry(raw, title) {
  if (/^\s*\[.*\]\(#/.test(raw)) return true;
  if (/(\.\s*){3,}|…|\t/.test(raw)) return true;
  return /\S\s+(\d{1,3}|[ivx]{1,5})\s*$/i.test(title || "");
}

/** What follows "Chapter 2" in a heading: nothing, punctuation, or a capitalised title. */
function headingRemainder(rest) {
  if (!rest) return true;
  if (!/^[A-Z“"'‘(\d]/.test(rest)) return false;
  if (/[,;]$/.test(rest)) return false;
  return !(/\.$/.test(rest) && words(rest) > 8);
}

// ---------- the document as lines ----------

/**
 * Running headers, running footers and bare page numbers in a PDF. A line counts as one when
 * it is short, sits in the first or last three lines of a page, and recurs on at least
 * three pages.
 *
 * The count is absolute rather than a share of the document, because a header that names
 * its chapter ("Chapter 2: Literature Review") repeats only across that chapter. Changing
 * numbers are ignored only when words surround them, so a header carrying its page number
 * matches itself from page to page while "Table 4" and "Table 5" opening two pages do not.
 */
function pdfFurniture(lines) {
  const loose = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const exact = (t) => t.replace(/\s+/g, " ").trim();
  const edge = (l) => l.index < 3 || l.last < 3;

  const pagesWith = new Map();
  const count = (k, page) => {
    if (!pagesWith.has(k)) pagesWith.set(k, new Set());
    pagesWith.get(k).add(page);
  };
  // Headers are short. Bounding the length keeps a recurring line of body text out.
  const candidate = (l) => edge(l) && l.text.trim() && words(l.text) <= 12;
  for (const l of lines) {
    if (!candidate(l)) continue;
    count(`=${exact(l.text)}`, l.page);
    if ((loose(l.text).match(/[a-z]{2,}/g) || []).length >= 2) count(`~${loose(l.text)}`, l.page);
  }
  const recurs = (k) => (pagesWith.get(k)?.size || 0) >= 3;
  return lines.map(
    (l) =>
      candidate(l) &&
      (/^\s*(page\s+)?(\d{1,4}|[ivxlc]{1,6})(\s*(of|\/)\s*\d{1,4})?\s*$/i.test(l.text) ||
        recurs(`=${exact(l.text)}`) ||
        recurs(`~${loose(l.text)}`)),
  );
}

/** Median type size of body text, weighted by characters, so headings can be told apart by size. */
function bodySize(lines) {
  const sizes = [];
  for (const l of lines) if (l.size) for (let i = 0; i < Math.min(l.text.length, 200); i += 10) sizes.push(l.size);
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)] || 0;
}

/**
 * Annotate each line with what the heading tests need: its bare text, whether it is page
 * furniture, and whether it is set apart the way a heading is (top of a page or larger type
 * in a PDF, a Markdown heading or a short standalone paragraph elsewhere).
 */
function annotate(doc) {
  const furniture = doc.kind === "pdf" ? pdfFurniture(doc.lines) : doc.lines.map(() => false);
  const body = doc.kind === "pdf" ? bodySize(doc.lines) : 0;

  // Position on the page counting only real lines, so a running header does not push the
  // chapter heading out of the top three.
  const topIndex = [];
  let page = null;
  let count = 0;
  doc.lines.forEach((l, i) => {
    if (l.page !== page) {
      page = l.page;
      count = 0;
    }
    topIndex[i] = furniture[i] || !l.text.trim() ? -1 : count++;
  });

  return doc.lines.map((l, i) => {
    const text = bare(l.text);
    const n = words(text);
    const top = doc.kind === "pdf" && topIndex[i] >= 0 && topIndex[i] < 3;
    const large = doc.kind === "pdf" && body > 0 && l.size >= body * 1.12;
    const caps = /[A-Z]/.test(text) && text === text.toUpperCase();
    // Set apart in a way only a heading is: opening a page or in larger type in a PDF, and a
    // heading style, bold, or capitals elsewhere.
    const strong = doc.kind === "pdf" ? top || large : l.level > 0 || /^\s*(#{1,6}\s+)?(\*\*|__)/.test(l.text) || caps;
    const standalone = doc.kind === "pdf" ? top || large || n <= 10 : l.level > 0 || n <= 14;
    return {
      raw: l.text,
      text,
      words: wordCount(l.text),
      page: l.page,
      level: l.level || 0,
      top: doc.kind === "pdf" ? top : l.level > 0,
      strong,
      furniture: furniture[i],
      standalone: standalone && n > 0 && n <= 20,
    };
  });
}

// ---------- finding chapter starts ----------

function labelledStarts(lines) {
  const found = [];
  lines.forEach((l, i) => {
    if (!l.standalone) return;
    const m = CHAPTER_LABEL.exec(l.text);
    if (!m) return;
    const n = numberOf(m[1]);
    const rest = m[2].trim();
    if (!n || !headingRemainder(rest) || looksLikeContentsEntry(l.raw, rest)) return;
    found.push({ line: i, n, title: rest });
  });
  return found;
}

/**
 * Headings that name a chapter rather than number it. In a DOCX these are the top-level
 * headings, once at least two of them carry a usual chapter title. A top level of ten
 * entries or fewer is then taken as the chapter list, and a longer one, which must be
 * holding sections too, is narrowed to the usual titles. In a PDF they are recognised by
 * name at the top of a page.
 */
function namedStarts(lines, kind) {
  const isName = (t) => CHAPTER_NAMES.some((re) => re.test(t));
  const strip = (t) => t.replace(/^(\d{1,2}|[ivx]{1,4})(\.0)?[.):]?\s+/i, "");
  const leading = (t) => {
    const m = /^(\d{1,2}|[ivx]{1,4})(\.0)?[.):]?\s+\S/i.exec(t);
    return m ? numberOf(m[1]) : null;
  };

  let picks;
  if (kind === "pdf") {
    picks = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.top && l.standalone && words(l.text) <= 8 && !looksLikeContentsEntry(l.raw, l.text) && isName(strip(l.text)));
  } else {
    const levels = lines.filter((l) => l.level > 0).map((l) => l.level);
    if (levels.length === 0) return [];
    const top = Math.min(...levels);
    const headings = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.level === top && !FRONT_MATTER.test(strip(l.text)) && !BACK_MATTER.test(strip(l.text)));
    const named = headings.filter(({ l }) => isName(strip(l.text)));
    // Two recognisable chapter titles at the top level mean the top level is chapters. One
    // chapter uploaded alone, its sections set as top-level headings, has at most one.
    if (named.length < 2) return [];
    picks = headings.length <= 10 ? headings : named;
  }

  // A heading name that recurs (Introduction, again, opening chapter 3) starts nothing new.
  const used = new Set();
  const out = [];
  for (const { l, i } of picks) {
    const kindIndex = CHAPTER_NAMES.findIndex((re) => re.test(strip(l.text)));
    if (kindIndex >= 0 && used.has(kindIndex)) continue;
    if (kindIndex >= 0) used.add(kindIndex);
    out.push({ line: i, n: leading(l.text) || out.length + 1, title: strip(l.text) });
  }
  return out;
}

/**
 * One start per chapter number. Consecutive labels with the same number form a run, a run's
 * weight is the text behind it up to the next run, and each number keeps its heaviest run.
 * Starts that would put the chapters out of order are dropped, lightest first.
 */
function chooseStarts(found, lines) {
  if (found.length === 0) return [];
  const wordsBetween = (a, b) => {
    let total = 0;
    for (let i = a; i < b; i += 1) if (!lines[i].furniture) total += lines[i].words;
    return total;
  };

  const runs = [];
  for (const f of found) {
    const last = runs[runs.length - 1];
    if (last && last.n === f.n) continue;
    runs.push({ ...f });
  }
  runs.forEach((run, k) => {
    run.weight = wordsBetween(run.line, k + 1 < runs.length ? runs[k + 1].line : lines.length);
  });

  const best = new Map();
  for (const run of runs) if (!best.has(run.n) || run.weight > best.get(run.n).weight) best.set(run.n, run);

  let chosen = [...best.values()].filter((r) => r.weight >= MIN_CHAPTER_WORDS).sort((a, b) => a.n - b.n);
  // Enforce document order matching chapter order.
  for (;;) {
    const bad = chosen.findIndex((r, k) => k > 0 && r.line <= chosen[k - 1].line);
    if (bad < 0) break;
    const lighter = chosen[bad].weight < chosen[bad - 1].weight ? bad : bad - 1;
    chosen = chosen.filter((_, k) => k !== lighter);
  }
  return chosen;
}

/**
 * Where the back matter begins. A references heading is often typed as a plain paragraph,
 * so a bare "References" counts. "Appendix A" also turns up in tables and captions inside a
 * chapter, so an appendix only counts when it is set as a heading.
 */
function backMatterLines(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (!l.standalone || l.furniture || words(l.text) > 10) return;
    if (!BACK_MATTER.test(l.text) || looksLikeContentsEntry(l.raw, l.text) || /[.,;]$/.test(l.text)) return;
    if (/^[a-z]/.test(l.text)) return;
    const plainReferences = REFERENCES.test(l.text) && words(l.text) <= 3;
    if (!l.strong && !plainReferences) return;
    out.push(i);
  });
  return out;
}

// ---------- assembling the result ----------

function textOf(doc, lines, from, to, keep) {
  const parts = [];
  let page = null;
  for (let i = from; i < to; i += 1) {
    const l = lines[i];
    if (l.furniture && i !== keep) continue;
    if (doc.kind === "pdf" && page !== null && l.page !== page) parts.push("");
    page = l.page;
    parts.push(doc.lines[i].text);
  }
  return finishText(doc.kind, parts.join("\n"));
}

const headingLine = (lines, start) => {
  // "CHAPTER TWO" on one line and the title on the next is common; show both. A named
  // heading ("Literature Review") is complete as it stands.
  const own = lines[start].text;
  const label = CHAPTER_LABEL.exec(own);
  if (!label || label[2]) return own;
  const next = lines.slice(start + 1, start + 4).find((l) => l.text && !l.furniture);
  return next && next.standalone && words(next.text) <= 12 && !CHAPTER_LABEL.test(next.text) ? `${own}: ${next.text}` : own;
};

/**
 * Split a document from extractLines into chapters.
 *
 * Returns { method, chapters: [{ n, heading, text, words, pages }], frontMatter: { words },
 * backMatter: [{ heading, words }] }. method is null and chapters empty when no chapter
 * structure could be found.
 */
export function splitDocument(doc) {
  const lines = annotate(doc);

  let method = "chapter-headings";
  let starts = chooseStarts(labelledStarts(lines), lines);
  if (starts.length === 0) {
    method = "named-headings";
    starts = chooseStarts(namedStarts(lines, doc.kind), lines);
  }
  if (starts.length === 0) return { method: null, chapters: [], frontMatter: null, backMatter: [] };

  const back = backMatterLines(lines);
  const firstBack = back.find((i) => i > starts[starts.length - 1].line);

  const chapters = starts.map((s, k) => {
    const nextStart = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    // A references heading inside the span ends the chapter there, which also drops
    // per-chapter reference lists from manuscript-style theses.
    const cut = back.find((i) => i > s.line && i < nextStart);
    const end = cut ?? nextStart;
    const text = textOf(doc, lines, s.line, end, s.line);
    let last = end - 1;
    while (last > s.line && (lines[last].furniture || !lines[last].text)) last -= 1;
    const pages = doc.kind === "pdf" ? [lines[s.line].page, lines[last].page] : null;
    return { n: s.n, heading: headingLine(lines, s.line), text, words: wordCount(text), pages };
  });

  const frontWords = lines.slice(0, starts[0].line).reduce((sum, l) => sum + (l.furniture ? 0 : l.words), 0);
  const backMatter = back
    .filter((i) => firstBack !== undefined && i >= firstBack)
    .map((i, k, arr) => {
      const end = k + 1 < arr.length ? arr[k + 1] : lines.length;
      const total = lines.slice(i, end).reduce((sum, l) => sum + (l.furniture ? 0 : l.words), 0);
      return { heading: lines[i].text, words: total };
    });

  return { method, chapters, frontMatter: { words: frontWords }, backMatter };
}
