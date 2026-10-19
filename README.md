# Doctoral Examination

A local Node.js app that examines a doctoral dissertation or a doctoral research
proposal. It generates evaluation criteria and a critical review for every chapter
automatically, cascading context forward so the same criticism is never made twice.

Node.js rewrite of `app_examination.py` (Streamlit), which is kept in place as the
reference implementation of the dissertation mode.

## Modes

Pick the mode in the sidebar before loading files. The choice is stored with the run, so
reopening a saved examination restores it.

| Mode         | Chapters | Judged on |
|--------------|----------|-----------|
| Dissertation | 1 to 6   | Introduction, Literature Review, Methodology, Results, Discussion, Conclusion |
| Proposal     | 1 to 3   | Introduction, Literature Review, Methodology |

The two modes are the same examination. Same cascade, same de-duplication, same
artifacts. What differs is the chapter set and the prose the prompts are built from: a
proposal is never asked about results it has not produced, Chapter 3 owns the whole
planned method including the analysis plan and its feasibility, and the verdict is
proposal approval rather than doctoral conferral. Everything mode-specific lives in
`server/modes.js`, and nothing else in the app hard-codes a chapter count.

## Architecture

| Layer      | Technology                                             |
|------------|--------------------------------------------------------|
| Frontend   | Single-page app, vanilla JS, no build step             |
| Backend    | Express (`server/`), server-sent events for progress   |
| Storage    | Plain files under `runs/<id>/`                         |
| Extraction | `pdfjs-dist` and `mammoth`, so no Python is needed     |
| Export     | `docx` for Word, `pdfmake` for PDF, Source Serif and Source Sans embedded |
| Model      | `.env` — `OPENAI_MODEL=gpt-5.6-sol`, `REASONING_EFFORT=high` |

## Run

```bash
./run.sh
```

Then open http://127.0.0.1:8020. The first run installs dependencies.

If the port is already held by an earlier copy, the app says so and exits. Either stop
the old one with `lsof -ti :8020 | xargs kill`, or pick another port with
`PORT=8021 npm start`. Ctrl-C shuts down cleanly and releases the port.

## Workflow

1. Choose the mode, then enter the title and any chair concerns in the sidebar.
2. Drop in the complete document, title page, references and appendices included, as one
   PDF or DOCX. Its chapters are found and loaded automatically and the sidebar reports
   the split, so it can be checked before anything is examined. Separate files named
   `chapter_1.pdf`, `Chapter 2.docx` and so on still work, and are assigned by name.
   PDF, DOCX, TXT and MD are accepted.
3. Press **Run full examination**. Everything below is produced in one pass, with live
   progress. Individual artifacts can be regenerated from their chapter tab afterwards.
4. Read the results across the chapter tabs, Final Review, Oral Defence and Analytics.
   Every artifact downloads as Word, PDF or Markdown from its card, and the complete
   examination package as Word, PDF or plain text from the Final Review tab.

## Splitting a complete document

A file whose name carries no chapter number is taken as the whole document and split in
`server/split.js`. Chapter starts are found from their headings: "Chapter 2",
"CHAPTER TWO", "Chapter II: Literature Review". The same label also appears where no
chapter starts, and each case is handled on its own terms:

| Where the label appears | How it is told apart |
|---|---|
| Table of contents | Entries carry page numbers or dot leaders, and a run of entries has almost no text behind it, so it loses to the chapter it lists |
| PDF running headers | Short lines repeated at page edges are dropped from the text, and repeats of a chapter's label join the run that chapter opened |
| The chapter 1 roadmap | "Chapter 2 reviews the literature" is a sentence. In a heading, what follows the number is punctuation, a capitalised title or nothing |

A document whose chapter numbers come from Word's list numbering has no label in its text.
For those the top-level headings are used, once at least two of them carry a usual chapter
title (Introduction, Literature Review, Methodology and so on).

Everything before Chapter 1 is front matter, and the last chapter ends at the references
or appendices. Only the chapters the mode covers are loaded. The sidebar lists each chapter
with the heading it was found at, its pages and its word count, the front and back matter
left out, any chapter in the document the mode does not cover, and any gap in the
numbering. Each chapter tab shows where its text came from, and a wrong chapter can be
corrected there by pasting.

`npm run reextract` re-derives chapter text from the stored originals, splitting complete
documents again.

## Exports

`server/export/` renders any artifact, or the complete package, as a designed document.
Both formats come from one document model, so they share a layout and a palette: a title
block naming the examination, the document and the date, running headers and page
numbers, section headings coloured by what they hold (strengths green, issues amber),
severity badges on every ranked issue, the **Where:** and **Evidence:** fields of each
issue set as a two-column grid, and tables with repeating header rows. The package adds a
cover page and a contents page, and starts each artifact on a new page.

The PDF embeds Adobe's Source Serif and Source Sans (SIL Open Font License), installed
from npm. Word does not embed fonts reliably, so the Word file uses Cambria and Calibri,
which Microsoft Office and Google Docs both provide.

```
GET /api/runs/<id>/export/<key>.<docx|pdf|md>
```

`key` is `summary`, `criteria-N`, `review-N`, `oral-N`, `finalReview`, `decisionLetter`,
`supervisorFeedback`, `overallOral`, `revisedAssessment`, `responseEvaluation`, or
`package`. The package holds what the plain-text package holds.

## The cascade

Criteria for chapter N are generated knowing which criteria chapters 1..N-1 already
cover. The review for chapter N is written knowing which issues chapters 1..N-1 already
raised, so a repeat issue is referenced by ID under **Recurring Issues** rather than
argued a second time.

```
Criteria_N  ← chapterText_N, coverage_1..N-1
Review_N    ← chapterText_N, Criteria_N, ledger_1..N-1
```

`Review_N` needs `Criteria_N` and `Review_{N-1}` but not `Criteria_{N+1}`, so the two
chains run as a pipeline with criteria one chapter ahead of reviews:

```
wave 1:  C1
wave 2:  C2 ‖ R1
wave 3:  C3 ‖ R2   …   wave 6: C6 ‖ R5   wave 7: R6
```

Twelve calls resolve in seven waves instead of twelve. The schedule is not hard-coded,
and neither is the chapter count. Each unit is a memoized promise that awaits its
dependencies, so the waves fall out of the dependency graph and a semaphore caps how
many calls are actually in flight. A three-chapter proposal is the same shape, six calls
in four waves.

Running concurrently from wave 1, since they depend on nothing in the cascade: the
document summary, the per-chapter oral question sets, and the overarching oral
questions. After the last review come the final review, which merges the whole issue
ledger, and then the decision letter.

The critical path is 9 sequential calls rather than the 20 of the Streamlit original.

## Writing style

Every artifact is written in the voice defined in `server/style.js`, ported from
`Grading/backend/grader.py`. It is applied at one point, `composeSystem()`, which builds
the system prompt for every call, so no individual prompt can opt out.

The style forbids colons, semicolons and dashes, while the examiner output format is
built on all three. The constant resolves this with a scaffolding exemption: the rules
bind the prose, and Markdown headings, table pipes, bold field labels, issue IDs and
severity words are reproduced exactly so the ledger stays machine-readable.

```bash
npm run style-check runs/<run-id>
```

strips the scaffolding and checks only the prose, and confirms each artifact quotes the
examined document directly.

## Persistence

Each examination is a folder under `runs/<id>/` holding the extracted chapter text and
every artifact as a plain `.md` or `.txt` file, written the moment it lands. A crash
costs one call rather than the run, and re-running an examination skips whatever is
already on disk unless *Regenerate everything* is ticked.

Uploading new chapter text clears the derived artifacts for that run, so a stale ledger
is never carried into what is effectively a new examination.

Every progress event is appended to `runs/<id>/events.log`, one JSON object per line, as
it goes out over the SSE stream. `meta.json` keeps only the final state of each unit, so a
failure nobody was watching would otherwise leave nothing to read; the log is the ordered,
timestamped history of what the cascade actually did. Server-side errors are printed to the
terminal with their stack.

Every uploaded file is also kept verbatim under `runs/<id>/uploads/`, which is what makes
a bad extraction diagnosable against the source months later. The sidebar lists them with
their size, downloads any one of them, and deletes any one of them, or all of them, at any
time. Deleting an original touches nothing else. The extracted text and every generated
artifact are separate files and survive, so a deletion never costs a model call.

## Layout

```
server/
  index.js      Express routes, SSE, static hosting
  pipeline.js   the cascading orchestrator
  modes.js      the modes, their chapters, scopes and prose
  split.js      finds the chapters inside a complete document
  prompts.js    every prompt, built from the run's mode
  style.js      the house writing style
  llm.js        OpenAI Responses wrapper, semaphore, retries
  parse.js      block splitting, ledger parsing, text normalization
  extract.js    PDF / DOCX / TXT extraction
  store.js      run persistence
  export/       Word and PDF rendering of every artifact
    index.js      the artifact catalogue and document model
    markdown.js   Markdown into blocks both renderers share
    docx.js       Word rendering
    pdf.js        PDF rendering
    theme.js      the shared palette and type scale
public/         index.html, app.js, style.css
scripts/        style-check.js, check-syntax.js, reextract.js
fixtures/       six short chapters for an end-to-end test
                (chapters 1 to 3 double as the proposal fixture set)
```

## Notes

- `npm run check` imports every server module, catching syntax and import errors
  without needing an API key.
- `_normalize_text` in the Python original collapses every paragraph break, because its
  lookarounds each span two characters and never fire on a plain blank line. The port in
  `server/parse.js` preserves paragraph structure, which the examiner needs in order to
  cite sections and tables. The deviation is documented at the function.
- AI-assisted examination. Final decisions must always involve human expert judgement.
