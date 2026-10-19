/**
 * Word and PDF export of every generated artifact, singly or as the complete package.
 *
 * Both formats are rendered from the same document model, built here from the run's
 * meta and artifacts. An artifact is addressed by a key such as `review-2` or
 * `finalReview`, which is also what the browser puts in the export URL.
 */
import { getMode } from "../modes.js";
import { parseMarkdown } from "./markdown.js";
import { renderDocx } from "./docx.js";
import { renderPdf } from "./pdf.js";

export const FORMATS = {
  docx: { ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pdf: { ext: "pdf", type: "application/pdf" },
  md: { ext: "md", type: "text/markdown; charset=utf-8" },
};

/**
 * Every exportable artifact for a mode, in the order the package presents them. The titles
 * match the cards in the app, so a file is recognisable as the thing it was downloaded from.
 */
export function catalogue(mode) {
  const chapterItems = mode.chapters.flatMap((n) => {
    const group = `Chapter ${n} · ${mode.descriptions[n].name}`;
    const chapter = (key, title, pick, file) => ({
      key: `${key}-${n}`,
      title,
      eyebrow: group,
      group,
      runningTitle: `Chapter ${n} · ${title}`,
      pick,
      file: `chapter_${n}_${file}`,
    });
    return [
      chapter("criteria", "Evaluation Criteria", (a) => a.criteria?.[n], "criteria"),
      chapter("review", "Chapter Review", (a) => a.reviews?.[n], "review"),
      chapter("oral", mode.oralHeading, (a) => a.oral?.[n], "oral_questions"),
    ];
  });

  const single = (key, title, file) => ({ key, title, eyebrow: "", runningTitle: title, pick: (a) => a[key], file });

  return [
    single("summary", `${mode.label} Summary`, "summary"),
    ...chapterItems,
    single("finalReview", "Final Comprehensive Review", "final_review"),
    single("decisionLetter", "Decision Letter", "decision_letter"),
    single("supervisorFeedback", "Supervisor Feedback Brief", "supervisor_feedback"),
    single("overallOral", "Overarching Defence Questions", "overall_oral_questions"),
    single("revisedAssessment", `Revised ${mode.label} Assessment`, "revised_assessment"),
    single("responseEvaluation", "Candidate Response Adequacy", "response_evaluation"),
  ];
}

/**
 * What the complete package holds. It mirrors the plain-text package, so the formatted
 * and the plain versions of the record never disagree about what the examination produced.
 */
const inPackage = (key) =>
  /^(criteria|review)-\d+$/.test(key) ||
  ["summary", "finalReview", "decisionLetter", "supervisorFeedback", "overallOral"].includes(key);

const has = (text) => Boolean(text && String(text).trim());

const formatDate = (iso) =>
  new Date(iso || Date.now()).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });

const slugOf = (meta, mode) => (meta.title || mode.shortNoun).replace(/[^\w]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

function baseModel(meta, mode) {
  const focus = (meta.chairConcerns || "").trim();
  return {
    heading: mode.heading,
    documentTitle: (meta.title || "").trim() || `Untitled ${mode.shortNoun}`,
    metaRows: [
      ["Date", formatDate(meta.finishedAt || meta.createdAt)],
      ["Examination", mode.label],
      ...(focus ? [["Examination focus", focus.length > 220 ? `${focus.slice(0, 218).trim()}…` : focus]] : []),
    ],
  };
}

function section(item, markdown) {
  return {
    key: item.key,
    title: item.title,
    eyebrow: item.eyebrow,
    group: item.group || null,
    runningTitle: item.runningTitle,
    blocks: parseMarkdown(markdown),
  };
}

/** Build the document model for one artifact key, or for `package`. Null when there is nothing to export. */
export function buildModel(meta, artifacts, key) {
  const mode = getMode(meta.mode);
  const items = catalogue(mode);

  if (key === "package") {
    const included = items.filter((item) => inPackage(item.key) && has(item.pick(artifacts)));
    if (included.length === 0) return null;
    const reviewed = mode.chapters.filter((n) => has(artifacts.reviews?.[n]));
    const base = baseModel(meta, mode);
    return {
      ...base,
      kind: "package",
      title: "Examination Package",
      file: "examination_package",
      coverRows: [
        ["Document", mode.noun.charAt(0).toUpperCase() + mode.noun.slice(1)],
        ["Chapters examined", reviewed.length ? reviewed.join(", ") : "None yet"],
        ["Date", base.metaRows[0][1]],
        ...(meta.chairConcerns?.trim() ? [["Examination focus", meta.chairConcerns.trim()]] : []),
        ["Prepared with", `${meta.model} at ${meta.reasoningEffort} reasoning effort`],
      ],
      sections: included.map((item) => section(item, item.pick(artifacts))),
      markdown: included.map((item) => `# ${item.eyebrow ? `${item.eyebrow} · ` : ""}${item.title}\n\n${item.pick(artifacts).trim()}`).join("\n\n"),
    };
  }

  const item = items.find((i) => i.key === key);
  if (!item || !has(item.pick(artifacts))) return null;
  return {
    ...baseModel(meta, mode),
    kind: "artifact",
    title: item.title,
    file: item.file,
    sections: [section(item, item.pick(artifacts))],
    markdown: item.pick(artifacts),
  };
}

/** Render one export. Returns { body, filename, contentType }, or null when the artifact does not exist yet. */
export async function exportArtifact(meta, artifacts, key, format) {
  const spec = FORMATS[format];
  if (!spec) throw Object.assign(new Error(`Unknown export format: ${format}`), { status: 400 });

  const model = buildModel(meta, artifacts, key);
  if (!model) return null;

  const body =
    format === "docx" ? await renderDocx(model) : format === "pdf" ? await renderPdf(model) : model.markdown;

  return {
    body,
    filename: `${slugOf(meta, getMode(meta.mode))}_${model.file}.${spec.ext}`,
    contentType: spec.type,
  };
}
