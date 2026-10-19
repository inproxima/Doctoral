/**
 * Prompt content ported from app_examination.py.
 *
 * The chapter scope fencing and the binding de-duplication rules are the substance
 * of this application, so they are carried over intact. Every call goes through
 * llm.ask, which prepends the house writing style from style.js.
 *
 * Every builder takes the run's mode as its first argument. Chapter numbers, chapter
 * remits, and the nouns and verdicts that differ between a dissertation and a
 * proposal all come from modes.js, so no prompt here hard-codes a chapter count.
 */
import { ask } from "./llm.js";
import { COVERAGE_TAG, LEDGER_TAG } from "./parse.js";

const severityScale = (mode) => `Severity labels (use these exact words):
- **Critical** — undermines ${mode.claim}; ${mode.criticalConsequence}.
- **Major** — a substantive flaw in rigour, evidence, or argument that requires significant rework.
- **Moderate** — a real weakness that a demanding examiner would require addressed, but that does not threaten the core claim.
- **Minor** — a small gap in clarity, completeness, or convention.`;

const bundleChapters = (mode, chapterTexts) =>
  mode.chapters
    .filter((n) => chapterTexts[n])
    .map((n) => `Chapter ${n} (${mode.descriptions[n].name}):\n${chapterTexts[n]}`)
    .join("\n\n");

const numbered = (items) => items.map((item, i) => `${i + 1}. ${item}`).join("\n");

const bulleted = (items) => items.map((item) => `- ${item}`).join("\n");

// ---------- cascading stage 1: criteria ----------

export function chapterCriteriaPrompt(mode, text, title, n, priorCoverage) {
  const { descriptor } = mode.descriptions[n];
  const scope = mode.scope[n];
  const alreadyCovered = priorCoverage
    ? `
CRITERIA ALREADY ESTABLISHED IN EARLIER CHAPTERS — do NOT restate or rephrase any of these.
The examination applies them once, where they belong.
${priorCoverage}
`
    : "";

  return `You are an examiner of a ${mode.noun} titled "${title}".
This is the ${descriptor}:

${text}

THIS CHAPTER'S REMIT — every criterion you generate must fall inside it:
${scope.owns}

OUT OF SCOPE — these belong to other chapters and will be judged there. Generate NO criteria for them:
${scope.notHere}
${alreadyCovered}
Generate rigorous evaluation criteria you will use to judge this chapter, and only this chapter.
Each criterion must be one this chapter alone can satisfy or fail — if a criterion could be applied
unchanged to any other chapter of any ${mode.shortNoun}, it is too generic: drop it or sharpen it until
it is specific to the remit above.

For each criterion give:
- a short title (5 words or fewer)
- a one-sentence description
- an explicit benchmark for what a doctoral-quality version of THIS chapter demonstrates

After the criteria, output this block exactly, listing each criterion title on its own line with no
numbering, bullets, or commentary:

<<<${COVERAGE_TAG}>>>
Criterion title
Criterion title
<<<END>>>`;
}

export const generateChapterCriteria = (...args) => ask(chapterCriteriaPrompt(...args));

// ---------- cascading stage 2: review ----------

export function chapterReviewPrompt(mode, text, criteria, title, n, priorLedger) {
  const { descriptor } = mode.descriptions[n];
  const scope = mode.scope[n];

  let recurrenceRules = "";
  // The fixed strings below are prose the model reproduces verbatim, so they obey the
  // house punctuation rules rather than relying on the scaffolding exemption.
  let recurringSection =
    "## 🔁 Recurring Issues\nWrite `Not applicable. This is the first chapter reviewed.`";

  if (priorLedger) {
    recurrenceRules = `
ISSUES ALREADY RAISED IN EARLIER CHAPTERS OF THIS EXAMINATION:
${priorLedger}

De-duplication rules — these are binding:
- If one of the issues above also manifests in this chapter, do NOT argue it again. List it under
  "Recurring Issues" as its ID plus ONE line of new, chapter-specific evidence. Nothing more.
- "Points to Consider" must contain only issues that are NEW to this chapter and not already
  covered by an ID above, even if worded differently. An issue that is merely a rephrasing of an
  existing ID is a recurrence, not a new point.
- If this chapter shows an existing issue is in fact resolved here, say so in one line under
  "Recurring Issues".
`;
    recurringSection =
      "## 🔁 Recurring Issues\n" +
      "References only, one line each, in the form `[C2-03] — new evidence in this chapter: …`. " +
      "No restatement of the issue, no rationale, no remedy. Write " +
      "`None. No earlier issue recurs in this chapter.` if that is the case.";
  }

  return `You are an examiner of a ${mode.noun} titled "${title}".
This is the ${descriptor}:

${text}

THIS CHAPTER'S REMIT — judge it on this and nothing else:
${scope.owns}

OUT OF SCOPE — belongs to other chapters and is judged there. Do not raise it as a fault of this chapter:
${scope.notHere}

Evaluation criteria to apply:
${criteria}
${recurrenceRules}
${severityScale(mode)}

Produce a critical, evidence-based review using EXACTLY these four Markdown headings, in this order:

## ✅ Strengths
Concrete strengths, each tied to a specific section, passage, table, or argument. No generic praise.

## ⚠️ Points to Consider
Only issues new to this chapter, RANKED most important first (Critical, then Major, then Moderate,
then Minor). Number them in rank order. Format each as:

### C${n}-01 · [Severity] Short title
- **Where:** section / page / table reference
- **Evidence:** what the text actually does or fails to do, including a direct quotation
- **Why it matters:** the consequence for ${mode.claim}
- **Resolution:** what a satisfactory version would look like

Use sequential IDs C${n}-01, C${n}-02, … in the ranked order.

${recurringSection}

## ✏️ Edit Points
A single Markdown table of every concrete change required in this chapter — substantive rewrites and
surface corrections alike — in this format:

| Location | Required edit | Ref |
|---|---|---|
| §${n}.2, p.47 | Rewrite the passage to state X explicitly and justify it | C${n}-02 |
| §${n}.4, Table 2 | Add a caption and state the units | — |

Ref cites the Point to Consider the edit discharges, or \`—\` for a standalone surface fix
(typo, grammar, citation style, figure/table labelling, inconsistent terminology).

Each fact appears exactly ONCE in this review: a Point to Consider carries the diagnosis and
rationale, its Edit Point carries only the concrete instruction. Do not repeat the rationale in the
table, and do not repeat the edit wording in the Points to Consider.

Finally, output this block exactly, one row per Point to Consider raised above (not recurrences),
pipe-delimited, no header row and no table separator line:

<<<${LEDGER_TAG}>>>
C${n}-01 | theme in 2-4 words | Severity | one-line statement of the issue
<<<END>>>

Maintain a fair but demanding standard appropriate for a research-intensive doctoral examination.`;
}

export const generateChapterReview = (...args) => ask(chapterReviewPrompt(...args));

// ---------- independent artifacts ----------

export function generateChapterOralQuestions(mode, text, title, n) {
  const { descriptor } = mode.descriptions[n];
  return ask(`You are an examiner in a ${mode.defence} for the ${mode.shortNoun} titled "${title}".
This is the ${descriptor}:

${text}

Generate a numbered list of critical oral-defence questions. Probe the candidate's:
- Conceptual command of the material
- Methodological choices and trade-offs
- Awareness of alternative interpretations
- Limitations and threats to validity
- Connection of this chapter to the broader ${mode.shortNoun} argument

Where useful, include short follow-up probes after a primary question.`);
}

export function generateOverallOralQuestions(mode, chapterTexts, title) {
  return ask(`You are an examiner in a ${mode.defence} for the ${mode.shortNoun} titled "${title}".

Full ${mode.shortNoun} content by chapter:
${bundleChapters(mode, chapterTexts)}

Generate a numbered list of overarching oral-defence questions that assess:
${bulleted(mode.overallOralFoci)}

Include short follow-up probes where useful.`);
}

export function generateDocumentSummary(mode, chapterTexts, title) {
  return ask(`You are a doctoral examiner reviewing the ${mode.shortNoun} titled "${title}".

Full ${mode.shortNoun} content by chapter:
${bundleChapters(mode, chapterTexts)}

Produce a comprehensive, well-structured summary covering:
${numbered(mode.summaryOutline)}

Be precise and objective.`);
}

// ---------- synthesis tail ----------

export function generateFinalReview(mode, chapterReviews, title, chairConcerns, ledger) {
  const blocks = mode.chapters
    .filter((n) => chapterReviews[n])
    .map((n) => `Chapter ${n} Review (${mode.descriptions[n].name}):\n${chapterReviews[n]}`)
    .join("\n\n");
  const focus = (chairConcerns || "").trim() || "(no specific focus provided)";
  const ledgerBlock = (ledger || "").trim() || "(no issue ledger available)";

  return ask(`You are an examiner producing the final assessment of the ${mode.noun} titled "${title}".

Examination focus / chair concerns: ${focus}

Consolidated issue ledger from every chapter (ID | theme | severity | statement):
${ledgerBlock}

Chapter-level reviews (source evidence):
${blocks}

Your task is to MERGE these into one assessment, not to concatenate them. Binding rules:
- Cluster issues that share a root cause into a SINGLE ${mode.shortNoun}-level point, even when they were
  raised in different chapters under different wording. Cite every ID you have folded into the point.
- An issue that recurred across chapters is stated ONCE, listing the chapters it affects.
- Nothing in the final list may be a restatement of something already listed above it.
- Every point must trace to evidence in the chapter reviews. Do not invent new issues.

${severityScale(mode)}

Rank the Points to Consider by importance using this rubric, applied in order:
1. Threat to ${mode.claim} (severity).
2. Breadth — how many chapters the issue affects, and whether it propagates downstream.
3. Effort to remedy, used only to break ties among otherwise equal points.

Use EXACTLY these four Markdown headings, in this order:

## ✅ Strengths of the ${mode.label}
The genuine strengths of the work as a whole, each tied to specific chapters and evidence. Merge
strengths that were noted in several chapters into one statement.

## ⚠️ Points to Consider (ranked)
A single numbered list ordered most important first across the WHOLE ${mode.shortNoun} — not grouped by
chapter. Format each as:

### 1. [Severity] Short title
- **Chapters affected:** e.g. ${mode.exampleChapters}
- **Folded from:** the issue IDs merged into this point
- **Evidence:** the specific basis in the ${mode.shortNoun}
- **Why it matters:** consequence for ${mode.claim}
- **Required action:** what the candidate must do to resolve it

## ✏️ Edit Points
Every concrete change required, consolidated and grouped under a \`### Chapter N\` subheading, as a
Markdown table \`| Location | Required edit | Ref |\`. Ref cites the number of the Point to Consider
above that the edit discharges, or \`—\` for a standalone surface fix. Do not repeat rationale here —
the instruction only. Drop duplicate edits that appeared in more than one chapter review.

## 🏁 Overall Judgement
One of: ${mode.verdicts}.
Give the rationale in a short paragraph, referring to the ranked points by number.

Be evidence-based and direct.`);
}

export function generateDecisionLetter(mode, title, finalReview, chairConcerns) {
  const focus = (chairConcerns || "").trim() || "(no specific focus provided)";
  return ask(
    `You are the chair of a ${mode.committee}. Draft a formal decision letter to the candidate for the ${mode.shortNoun} titled "${title}".

Examination focus / chair concerns: ${focus}

Final assessment to base the letter on:
${finalReview}

The letter must include:
1. Examination Decision (${mode.decisions})
2. Decision Rationale (concise, grounded in the assessment)
3. Summary of examiner concerns (organized by theme)
4. Required Actions (specific, numbered, with priority) if revisions are required
5. Recommendations for strengthening the work
6. Timeline for revisions if applicable

Draw the Required Actions directly from the assessment's ranked "Points to Consider", preserving
that rank order. Do not re-derive, re-rank, or expand the list, and do not repeat an action that a
higher-numbered action already covers.

Start with "Dear Candidate," and end with "Sincerely, [Committee Chair] on behalf of the Examination Committee."

Maintain a professional, constructive, and direct tone.`,
    { role: `You are the chair of a ${mode.committee}.` },
  );
}

export function generateSupervisorFeedback(mode, title, chapterReviews, finalReview, ledger, chairConcerns) {
  const blocks = mode.chapters
    .filter((n) => chapterReviews[n])
    .map((n) => `Chapter ${n} Review (${mode.descriptions[n].name}):\n${chapterReviews[n]}`)
    .join("\n\n");
  const focus = (chairConcerns || "").trim() || "(no specific focus provided)";
  const ledgerBlock = (ledger || "").trim() || "(no issue ledger available)";

  return ask(`You are the examiner writing a private briefing for the candidate's supervisor about the ${mode.noun} titled "${title}".
${mode.supervisorContext}

Examination focus / chair concerns: ${focus}

Consolidated issue ledger from every chapter (ID | theme | severity | statement):
${ledgerBlock}

Final assessment:
${finalReview}

Chapter-level reviews — your ONLY source of quotations and locations:
${blocks}

Evidence rules, all binding:
- Every point must carry a direct quotation from the ${mode.shortNoun}, reproduced VERBATIM from the
  chapter reviews above. Never invent, trim, or paraphrase inside quotation marks.
- Cite the location as chapter number plus section heading or table. Give a page number ONLY when a
  chapter review's Where field already states one. Never guess a page.
- Rank points from most critical to most minor using the severities already assigned in the ledger
  and reviews. Do not re-derive severity.
- Raise nothing that is absent from the reviews and ledger above.

Use EXACTLY these three Markdown headings, in this order:

## 👁️ What I Saw
A short, candid account for the supervisor of the overall state of the work, its genuine strengths,
and the pattern behind the weaknesses. Address the supervisor directly.

## 🗣️ What to Communicate to the Student (ranked)
A single numbered list, most critical first. Format each as:

### 1. [Severity] Short title
- **Where:** chapter and section reference, with a page only if a review already cites one
- **Evidence:** the direct quotation and what it shows
- **Why it matters:** the consequence for ${mode.claim}
- **Suggested framing:** how the supervisor might raise it so the student can act on it

## 🤝 Closing Note to the Supervisor
One short paragraph on priorities and sequencing, referring to the ranked points by number.

Write to the supervisor as a trusted colleague. Be direct about severity while staying constructive.`);
}

// ---------- revision round ----------

export function generateRevisedAssessment(mode, revisedText, title, criteriaBundle, priorFinalReview, chairConcerns) {
  const focus = (chairConcerns || "").trim() || "(no specific focus provided)";
  return ask(`You are conducting a second-round examination of the revised ${mode.noun} titled "${title}".

Examination focus / chair concerns: ${focus}

Prior evaluation criteria (all chapters):
${criteriaBundle}

Prior final assessment:
${priorFinalReview}

Revised ${mode.shortNoun} (full text):
${revisedText}

Produce a structured second-round report:
1. Resolved Items — issues now satisfactorily addressed, with specific evidence from the revised text.
2. Partially Resolved Items — what improved and what still falls short.
3. Unresolved or New Issues — original concerns still unmet plus any new concerns introduced by the revisions.
4. Overall Judgement — concise recommendation (${mode.decisions}).

Be precise and cite sections where possible.`);
}

export function evaluateCandidateResponse(mode, responseText, priorFinalReview, revisedText, criteriaBundle, chairConcerns) {
  const focus = (chairConcerns || "").trim() || "(no specific focus provided)";
  return ask(`You are reviewing the candidate's point-by-point response letter for a ${mode.noun} revision.

Examination focus / chair concerns: ${focus}

Prior evaluation criteria (all chapters):
${criteriaBundle}

Prior final assessment (issues to be addressed):
${priorFinalReview}

Candidate's response letter:
${responseText}

Revised ${mode.shortNoun} (evidence):
${revisedText}

Produce a structured adequacy matrix as a Markdown table. For each substantive issue from the prior assessment:
- Issue (concise restatement)
- Candidate's Response Summary
- Evidence in the Revised ${mode.label} (section / page where possible)
- Adequacy Rating: Fully Addressed / Partially Addressed / Not Addressed
- Notes

Conclude with an Overall Adequacy Score and a list of remaining changes still required.`);
}
