/**
 * The cascading examination orchestrator.
 *
 * Dependency graph:
 *
 *   Criteria_N  ← chapterText_N, coverage_1..N-1        (strict chain C1→C2→…→CLast)
 *   Review_N    ← chapterText_N, Criteria_N, ledger_1..N-1
 *
 * Review_N needs Criteria_N and Review_{N-1}, but not Criteria_{N+1}. The two chains
 * therefore run as a software pipeline with criteria one chapter ahead of reviews. For
 * the six chapters of a dissertation:
 *
 *   wave 1: C1
 *   wave 2: C2 ‖ R1
 *   wave 3: C3 ‖ R2   …   wave 6: C6 ‖ R5   wave 7: R6
 *
 * Twelve calls resolve in seven waves rather than twelve, and the cascade semantics
 * stay intact: R_N still sees the full ledger of R_1..R_{N-1}, C_N still sees the
 * full coverage of C_1..C_{N-1}. A three-chapter proposal is the same shape, six calls
 * in four waves.
 *
 * The schedule is not hard-coded, and neither is the chapter count. Each unit is a
 * memoized promise that awaits its dependencies, so the waves above fall out of the
 * graph and the semaphore in llm.js caps how many are actually in flight. The chapter
 * list comes from the run's mode.
 *
 * Independent of that pipeline and started immediately: the document summary, the
 * per-chapter oral question sets, and the overarching oral questions. Sequential tail
 * after the last review: final review, then decision letter.
 */
import { getMode } from "./modes.js";
import * as prompts from "./prompts.js";
import * as store from "./store.js";
import { COVERAGE_TAG, LEDGER_TAG, splitBlock } from "./parse.js";
import { MAX_CONCURRENT_CALLS, stats } from "./llm.js";

const running = new Map();

export const isRunning = (runId) => running.has(runId);

/** Units in the order the UI lists them, used for progress totals. */
export function unitList(mode) {
  const units = [];
  for (const n of mode.chapters) units.push(`criteria:${n}`, `review:${n}`, `oral:${n}`);
  units.push("summary", "overallOral", "finalReview", "decisionLetter", "supervisorFeedback");
  return units;
}

function priorCoverage(mode, n, coverage) {
  return mode.chapters
    .filter((k) => k < n && (coverage[k] || "").trim())
    .map(
      (k) =>
        `Chapter ${k} (${mode.descriptions[k].name}) criteria already cover:\n${coverage[k].trim()}`,
    )
    .join("\n\n");
}

function priorLedger(mode, n, ledger) {
  return mode.chapters
    .filter((k) => k < n && (ledger[k] || "").trim())
    .map((k) => `From Chapter ${k} (${mode.descriptions[k].name}):\n${ledger[k].trim()}`)
    .join("\n\n");
}

/** Everything the cascade raised, so one past the last chapter of whichever mode this is. */
export function fullLedger(mode, ledger) {
  return priorLedger(mode, mode.chapters[mode.chapters.length - 1] + 1, ledger);
}

/**
 * Run a full examination. Returns a promise resolving when every unit has settled.
 *
 * @param emit  called with progress events, forwarded to the browser over SSE
 * @param force when false, any unit whose artifact already exists on disk is skipped
 */
export async function runExamination(runId, { emit = () => {}, force = false } = {}) {
  if (running.has(runId)) return running.get(runId);

  const job = execute(runId, { emit, force }).finally(() => running.delete(runId));
  running.set(runId, job);
  return job;
}

async function execute(runId, { emit, force }) {
  const meta = await store.readMeta(runId);
  const artifacts = await store.loadArtifacts(runId);

  const mode = getMode(meta.mode);
  const chapters = artifacts.chapters;
  const present = mode.chapters.filter((n) => (chapters[n] || "").trim());
  if (present.length === 0) throw new Error("No chapter text has been uploaded for this run.");

  const title = meta.title || `(untitled ${mode.shortNoun})`;
  const concerns = meta.chairConcerns || "";

  // Live state the cascade reads from. Pre-seeded from disk so a resumed run still
  // carries forward everything earlier chapters established.
  const coverage = { ...artifacts.coverage };
  const ledger = { ...artifacts.ledger };
  const criteriaText = { ...artifacts.criteria };
  const reviewText = { ...artifacts.reviews };

  const startedAt = Date.now();
  stats.peakInFlight = 0;
  stats.calls = 0;

  await store.updateMeta(runId, (m) => {
    m.status = "running";
    m.startedAt = new Date().toISOString();
  });
  emit({ type: "run:start", units: unitList(mode), chapters: present });

  const failures = [];

  /** Wrap one unit: skip-if-present, timing, artifact write, progress events. */
  async function unit(name, existing, work) {
    if (!force && existing !== undefined && existing !== null && String(existing).trim()) {
      emit({ type: "unit:skipped", unit: name });
      await store.updateMeta(runId, (m) => {
        m.units[name] = { ...(m.units[name] || {}), status: "skipped" };
      });
      return existing;
    }

    const t0 = Date.now();
    emit({ type: "unit:start", unit: name, at: t0 });
    await store.updateMeta(runId, (m) => {
      m.units[name] = { status: "running", startedAt: new Date(t0).toISOString() };
    });

    try {
      const result = await work();
      const t1 = Date.now();
      await store.updateMeta(runId, (m) => {
        m.units[name] = {
          status: "done",
          startedAt: new Date(t0).toISOString(),
          finishedAt: new Date(t1).toISOString(),
          ms: t1 - t0,
        };
      });
      emit({ type: "unit:done", unit: name, ms: t1 - t0 });
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      failures.push({ unit: name, error: message });
      await store.updateMeta(runId, (m) => {
        m.units[name] = { status: "failed", error: message };
      });
      emit({ type: "unit:failed", unit: name, error: message });
      throw err;
    }
  }

  // ---- memoized graph nodes ------------------------------------------------

  const criteriaJobs = new Map();
  const reviewJobs = new Map();

  function criteriaJob(n) {
    if (!criteriaJobs.has(n)) criteriaJobs.set(n, buildCriteria(n));
    return criteriaJobs.get(n);
  }

  async function buildCriteria(n) {
    if (n > 1) await criteriaJob(n - 1).catch(() => {}); // a failed link must not stall the chain
    return unit(`criteria:${n}`, criteriaText[n], async () => {
      const raw = await prompts.generateChapterCriteria(
        mode,
        chapters[n],
        title,
        n,
        priorCoverage(mode, n, coverage),
      );
      const { visible, body } = splitBlock(raw, COVERAGE_TAG);
      criteriaText[n] = visible;
      coverage[n] = body;
      await store.writeArtifact(runId, store.ARTIFACT_FILES.criteria(n), visible);
      await store.writeArtifact(runId, store.ARTIFACT_FILES.coverage(n), body);
      emit({ type: "artifact", kind: "criteria", chapter: n });
      return visible;
    });
  }

  function reviewJob(n) {
    if (!reviewJobs.has(n)) reviewJobs.set(n, buildReview(n));
    return reviewJobs.get(n);
  }

  async function buildReview(n) {
    await criteriaJob(n).catch(() => {});
    if (n > 1) await reviewJob(n - 1).catch(() => {});
    if (!criteriaText[n]) throw new Error(`Chapter ${n} criteria unavailable, review skipped.`);

    return unit(`review:${n}`, reviewText[n], async () => {
      const raw = await prompts.generateChapterReview(
        mode,
        chapters[n],
        criteriaText[n],
        title,
        n,
        priorLedger(mode, n, ledger),
      );
      const { visible, body } = splitBlock(raw, LEDGER_TAG);
      reviewText[n] = visible;
      ledger[n] = body;
      await store.writeArtifact(runId, store.ARTIFACT_FILES.review(n), visible);
      await store.writeArtifact(runId, store.ARTIFACT_FILES.ledger(n), body);
      emit({ type: "artifact", kind: "review", chapter: n });
      return visible;
    });
  }

  // ---- launch ---------------------------------------------------------------

  // The pipeline. Kicking off every review job at once is what creates the C(N+1) ‖ R(N)
  // overlap: each one parks on its own dependencies and the semaphore does the throttling.
  const cascade = present.map((n) => reviewJob(n));

  // Fully independent of the cascade, so they start in wave 1 and fill any spare
  // slot the semaphore has while the chain is waiting on a single call.
  const independent = [
    unit("summary", artifacts.summary, async () => {
      const text = await prompts.generateDocumentSummary(mode, chapters, title);
      await store.writeArtifact(runId, store.SINGLETON_FILES.summary, text);
      emit({ type: "artifact", kind: "summary" });
      return text;
    }),
    unit("overallOral", artifacts.overallOral, async () => {
      const text = await prompts.generateOverallOralQuestions(mode, chapters, title);
      await store.writeArtifact(runId, store.SINGLETON_FILES.overallOral, text);
      emit({ type: "artifact", kind: "overallOral" });
      return text;
    }),
    ...present.map((n) =>
      unit(`oral:${n}`, artifacts.oral[n], async () => {
        const text = await prompts.generateChapterOralQuestions(mode, chapters[n], title, n);
        await store.writeArtifact(runId, store.ARTIFACT_FILES.oral(n), text);
        emit({ type: "artifact", kind: "oral", chapter: n });
        return text;
      }),
    ),
  ];

  await Promise.allSettled([...cascade, ...independent]);

  // ---- synthesis tail -------------------------------------------------------

  const reviewedChapters = present.filter((n) => (reviewText[n] || "").trim());

  let finalReview = artifacts.finalReview;
  if (reviewedChapters.length > 0) {
    try {
      finalReview = await unit("finalReview", artifacts.finalReview, async () => {
        const text = await prompts.generateFinalReview(
          mode,
          reviewText,
          title,
          concerns,
          fullLedger(mode, ledger),
        );
        await store.writeArtifact(runId, store.SINGLETON_FILES.finalReview, text);
        emit({ type: "artifact", kind: "finalReview" });
        return text;
      });
    } catch {
      finalReview = null;
    }
  } else {
    emit({ type: "unit:failed", unit: "finalReview", error: "No chapter reviews were produced." });
    failures.push({ unit: "finalReview", error: "No chapter reviews were produced." });
  }

  if (finalReview && String(finalReview).trim()) {
    // Both depend only on the final review, so they run side by side.
    const letter = unit("decisionLetter", artifacts.decisionLetter, async () => {
      const text = await prompts.generateDecisionLetter(mode, title, finalReview, concerns);
      await store.writeArtifact(runId, store.SINGLETON_FILES.decisionLetter, text);
      emit({ type: "artifact", kind: "decisionLetter" });
      return text;
    });
    const brief = unit("supervisorFeedback", artifacts.supervisorFeedback, async () => {
      const text = await prompts.generateSupervisorFeedback(
        mode,
        title,
        reviewText,
        finalReview,
        fullLedger(mode, ledger),
        concerns,
      );
      await store.writeArtifact(runId, store.SINGLETON_FILES.supervisorFeedback, text);
      emit({ type: "artifact", kind: "supervisorFeedback" });
      return text;
    });
    await Promise.allSettled([letter, brief]);
  } else {
    for (const u of ["decisionLetter", "supervisorFeedback"]) {
      emit({
        type: "unit:failed",
        unit: u,
        error: "No final review available to base it on.",
      });
      failures.push({
        unit: u,
        error: "No final review available to base it on.",
      });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const status = failures.length === 0 ? "done" : "done_with_errors";

  await store.updateMeta(runId, (m) => {
    m.status = status;
    m.finishedAt = new Date().toISOString();
    m.elapsedMs = elapsedMs;
    m.errors = failures;
    // Recorded so the parallelism can be verified after the fact rather than assumed.
    m.concurrency = {
      cap: MAX_CONCURRENT_CALLS,
      peakInFlight: stats.peakInFlight,
      modelCalls: stats.calls,
    };
  });
  emit({
    type: "run:done",
    status,
    elapsedMs,
    failures,
    peakInFlight: stats.peakInFlight,
    modelCalls: stats.calls,
  });

  return { status, failures, elapsedMs };
}

/** Regenerate one chapter unit on demand, with the same cascade context. */
export async function regenerateUnit(runId, kind, n) {
  const meta = await store.readMeta(runId);
  const artifacts = await store.loadArtifacts(runId);
  const mode = getMode(meta.mode);
  const title = meta.title || `(untitled ${mode.shortNoun})`;
  const text = artifacts.chapters[n];
  if (!text) throw new Error(`Chapter ${n} has no text.`);

  if (kind === "criteria") {
    const raw = await prompts.generateChapterCriteria(
      mode,
      text,
      title,
      n,
      priorCoverage(mode, n, artifacts.coverage),
    );
    const { visible, body } = splitBlock(raw, COVERAGE_TAG);
    await store.writeArtifact(runId, store.ARTIFACT_FILES.criteria(n), visible);
    await store.writeArtifact(runId, store.ARTIFACT_FILES.coverage(n), body);
    return visible;
  }

  if (kind === "review") {
    const criteria = artifacts.criteria[n];
    if (!criteria) throw new Error(`Generate criteria for chapter ${n} first.`);
    const raw = await prompts.generateChapterReview(
      mode,
      text,
      criteria,
      title,
      n,
      priorLedger(mode, n, artifacts.ledger),
    );
    const { visible, body } = splitBlock(raw, LEDGER_TAG);
    await store.writeArtifact(runId, store.ARTIFACT_FILES.review(n), visible);
    await store.writeArtifact(runId, store.ARTIFACT_FILES.ledger(n), body);
    return visible;
  }

  if (kind === "oral") {
    const out = await prompts.generateChapterOralQuestions(mode, text, title, n);
    await store.writeArtifact(runId, store.ARTIFACT_FILES.oral(n), out);
    return out;
  }

  throw new Error(`Unknown unit kind: ${kind}`);
}
