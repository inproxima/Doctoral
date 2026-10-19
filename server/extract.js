/**
 * Extract plain text from uploaded files (.pdf, .docx, .txt, .md).
 *
 * Replaces PyPDF2 and python-docx from the Python original, so the app needs no
 * Python interpreter and no virtual environment.
 */
import path from "node:path";

import mammoth from "mammoth";

import { normalizeText } from "./parse.js";

export async function extractText(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return finishText("pdf", await fromPdf(buffer));
  if (ext === ".docx") return finishText("docx", await fromDocx(buffer));
  return finishText("text", buffer.toString("utf8"));
}

/**
 * The last step of every extraction, shared with the chapter splitter so a chapter cut from
 * a full document is cleaned exactly as the same chapter uploaded on its own would be.
 */
export function finishText(kind, raw) {
  return normalizeText(kind === "docx" ? raw : stripDataUris(raw));
}

/**
 * The document as lines, before paragraphs are re-joined, for the chapter splitter.
 *
 * normalizeText joins every soft-wrapped line, which in a PDF also joins a chapter heading
 * onto the paragraph below it, so headings have to be found first. PDF lines carry their
 * page, their position on it and their type size. DOCX and text lines carry their Markdown
 * heading level.
 */
export async function extractLines(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") {
    const pages = await pdfPages(buffer);
    return {
      kind: "pdf",
      lines: pages.flatMap((lines, p) => lines.map((line, i) => ({ ...line, page: p + 1, index: i, last: lines.length - 1 - i }))),
    };
  }
  const kind = ext === ".docx" ? "docx" : "text";
  const raw = kind === "docx" ? await fromDocx(buffer) : buffer.toString("utf8");
  return {
    kind,
    lines: raw.split(/\r?\n/).map((text) => ({ text, level: /^(#{1,6})\s/.exec(text)?.[1].length || 0 })),
  };
}

/**
 * Collapse any inline data: URI to a placeholder.
 *
 * A base64-encoded figure is worth nothing to an examiner that reads text, and costs
 * roughly 1.4 characters of prompt per byte of image. One chapter carrying 49 embedded
 * figures arrived as 1.4 MB of text against 87 KB of actual writing and was rejected by
 * the API before a word of it was read. Markdown and pasted text can carry them too,
 * so every extraction path passes through here.
 */
function stripDataUris(text) {
  return (text || "")
    .replace(/!\[([^\]]*)\]\(\s*data:[^)]*\)/g, (_, alt) => figurePlaceholder(alt))
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']data:[^"']*["'][^>]*>/gi, "[Figure]")
    .replace(/\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{100,}/gi, "[Figure]");
}

/**
 * Word records the alt text of a pasted figure as the local path it came from, e.g.
 * "C:\Users\…\Content.MSO\9B15ED2B.tmp". A real caption is kept because the examiner
 * is asked to cite figures; a filesystem path is not, because it says nothing.
 */
function figurePlaceholder(alt) {
  const caption = (alt || "").trim();
  const looksLikePath = /[\\/]/.test(caption) || /\.(tmp|png|jpe?g|gif|bmp|emf|wmf|svg)$/i.test(caption);
  return caption && !looksLikePath ? `[Figure: ${caption}]` : "[Figure]";
}

async function fromPdf(buffer) {
  const pages = await pdfPages(buffer);
  return pages.map((lines) => lines.map((l) => l.text).join("\n")).join("\n\n");
}

/** Every page as a list of lines, each with the largest type size used on it. */
async function pdfPages(buffer) {
  // The legacy build is the one that runs under plain Node without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // pdf.js emits an explicit hasEOL flag on each item, which reconstructs line
    // breaks far more reliably than guessing from x/y coordinates.
    let line = { text: "", size: 0 };
    const lines = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      line.text += item.str;
      if (item.str.trim()) {
        const size = item.height || Math.hypot(item.transform[2], item.transform[3]);
        line.size = Math.max(line.size, Math.round(size * 10) / 10);
      }
      if (item.hasEOL) {
        lines.push(line);
        line = { text: "", size: 0 };
      }
    }
    if (line.text) lines.push(line);
    pages.push(lines);
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

async function fromDocx(buffer) {
  // convertToMarkdown keeps table content, which extractRawText silently drops.
  // Results and sampling frames are judged partly on their tables, so that content has to survive.
  //
  // The image converter is overridden because mammoth's default one inlines every figure
  // as a base64 data: URI. Emitting an empty src keeps the figure's position and caption in
  // the text and leaves the payload out of it entirely, rather than building a megabyte of
  // base64 only for stripDataUris to throw away.
  const { value } = await mammoth.convertToMarkdown(
    { buffer },
    { convertImage: mammoth.images.imgElement(() => ({ src: "" })) },
  );

  // Mammoth escapes any character that could be read as Markdown, so "3.1 Research
  // Design" arrives as "3\.1 Research Design". Left in place those backslashes reach
  // the examiner inside every section reference it quotes back. Unescaping is safe
  // here because the escapes are mammoth's own, not the candidate's.
  const unescaped = value.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");

  // The empty-src images the converter above left behind, plus anything a data: URI
  // still slipped through on (an <img> pasted into the document as literal HTML).
  return stripWordNoise(
    stripDataUris(unescaped.replace(/!\[([^\]]*)\]\(\s*\)/g, (_, alt) => figurePlaceholder(alt))),
  );
}

/**
 * Mammoth marks every bookmark Word keeps for its table of contents as an empty
 * <a id="_Toc…"></a>, and bold that spans only whitespace as "__ __". Neither is the
 * candidate's writing, but the examiner read both as such and asked the candidate to
 * "remove raw HTML anchors" and "stray formatting marks" from the chapter.
 */
function stripWordNoise(text) {
  return text
    .replace(/<a\s+id="[^"]*"\s*>\s*<\/a>/gi, "")
    .replace(/(__|\*\*)(\s*)\1/g, "$2");
}

/**
 * Auto-assign a file to a chapter from its name, e.g. "chapter_3.pdf", "Chapter 3.docx" or
 * "ch3.pdf". A name with no chapter in it is a whole document, and is split instead.
 *
 * "ch" only counts at the start of a word, because a complete document is routinely called
 * something like "Research2026.pdf" or "March1_thesis.docx", and reading those as chapters 2
 * and 1 would bypass the split. The whole number is read, so chapter_10 is not chapter 1.
 *
 * Only chapters the run's mode actually has are matched, so a chapter_5 file dropped into
 * a proposal is left unassigned rather than quietly accepted and then never examined.
 */
export function chapterFromFilename(filename, chapters) {
  const stem = path.basename(filename, path.extname(filename));
  const m = /chapter[\s_.-]*(\d{1,2})(?!\d)/i.exec(stem) || /(?:^|[^a-z])ch[\s_.-]*(\d{1,2})(?!\d)/i.exec(stem);
  const n = m ? Number(m[1]) : null;
  return n && chapters.includes(n) ? n : null;
}
