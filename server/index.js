/** Express application: REST API, SSE progress stream, and the static SPA. */
import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";

import * as llm from "./llm.js";
import * as store from "./store.js";
import * as pipeline from "./pipeline.js";
import * as prompts from "./prompts.js";
import { extractLines, extractText, chapterFromFilename } from "./extract.js";
import { splitDocument } from "./split.js";
import { DEFAULT_MODE, getMode, isMode, modeCatalogue } from "./modes.js";
import { exportArtifact, FORMATS as EXPORT_FORMATS } from "./export/index.js";
import { parseLedger, recurrenceMap, wordCount } from "./parse.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8020);
const HOST = process.env.HOST || "127.0.0.1";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

const app = express();

// When hosted, APP_PASSWORD gates everything behind HTTP basic auth (any username).
if (APP_PASSWORD) {
  const expected = crypto.createHash("sha256").update(APP_PASSWORD).digest();
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    const password = scheme === "Basic" ? Buffer.from(encoded || "", "base64").toString().split(":").slice(1).join(":") : "";
    const given = crypto.createHash("sha256").update(password).digest();
    if (crypto.timingSafeEqual(given, expected)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Doctoral Examiner"').status(401).send("Authentication required.");
  });
}

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(ROOT, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
});

/** Async route wrapper, so a rejected promise becomes a 500 instead of a hang. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- config ----------

app.get("/api/config", (_req, res) => {
  res.json({
    model: llm.MODEL,
    reasoningEffort: llm.REASONING_EFFORT,
    maxConcurrentCalls: llm.MAX_CONCURRENT_CALLS,
    modes: modeCatalogue(),
    defaultMode: DEFAULT_MODE,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.post(
  "/api/test-model",
  wrap(async (_req, res) => {
    try {
      const text = await llm.callModel(
        "You are a connectivity check.",
        "Reply with the single word: ok",
        { maxOutputTokens: 2000 },
      );
      res.json({ ok: true, model: llm.MODEL, reply: text.slice(0, 200) });
    } catch (e) {
      res.json({ ok: false, model: llm.MODEL, error: e.message });
    }
  }),
);

// ---------- runs ----------

app.get(
  "/api/runs",
  wrap(async (_req, res) => res.json(await store.listRuns())),
);

app.post(
  "/api/runs",
  wrap(async (req, res) => {
    if (req.body?.mode && !isMode(req.body.mode))
      return res.status(400).json({ error: "Unknown examination mode." });

    const meta = await store.createRun({
      title: req.body?.title,
      chairConcerns: req.body?.chairConcerns,
      mode: req.body?.mode,
      model: llm.MODEL,
      reasoningEffort: llm.REASONING_EFFORT,
    });
    res.json(meta);
  }),
);

app.get(
  "/api/runs/:id",
  wrap(async (req, res) => {
    const meta = await store.readMeta(req.params.id);
    const artifacts = await store.loadArtifacts(req.params.id);
    res.json({ meta, artifacts, running: pipeline.isRunning(req.params.id) });
  }),
);

app.patch(
  "/api/runs/:id",
  wrap(async (req, res) => {
    const nextMode = req.body?.mode;
    if (nextMode !== undefined && !isMode(nextMode))
      return res.status(400).json({ error: "Unknown examination mode." });

    // Switching mode changes which chapters exist, so it is only allowed while the run is
    // still empty. Once chapter text is in, the artifacts on disk are keyed to the old
    // chapter set and the honest answer is a new examination.
    if (nextMode) {
      const current = await store.readMeta(req.params.id);
      if (nextMode !== current.mode && Object.keys(current.chapters || {}).length > 0)
        return res.status(409).json({
          error: "Chapter files are already loaded. Start a new examination to change the mode.",
        });
    }

    const meta = await store.updateMeta(req.params.id, (m) => {
      if (typeof req.body?.title === "string") m.title = req.body.title;
      if (typeof req.body?.chairConcerns === "string") m.chairConcerns = req.body.chairConcerns;
      if (nextMode) m.mode = nextMode;
    });
    res.json(meta);
  }),
);

// ---------- upload ----------

/** A file named for its chapter: its whole text is that chapter, as it always was. */
async function loadChapterFile(id, name, file, n) {
  let text = "";
  let error = null;
  try {
    text = await extractText(name, file.buffer);
    if (!text.trim()) error = "No text could be extracted. A scanned PDF needs OCR before it can be read.";
  } catch (e) {
    error = e.message;
  }

  // The original is kept even when extraction fails, since that is exactly the file worth
  // opening by hand afterwards.
  const upload = await store.saveUpload(id, {
    filename: name,
    buffer: file.buffer,
    kind: "chapter",
    chapter: n,
    mimetype: file.mimetype,
    error,
  });
  if (error) return { filename: name, kind: "chapter", chapter: n, words: 0, error, uploadId: upload.id, assigned: [] };

  await store.writeArtifact(id, store.ARTIFACT_FILES.chapter(n), text);
  const words = wordCount(text);
  return {
    filename: name,
    kind: "chapter",
    chapter: n,
    words,
    error: null,
    uploadId: upload.id,
    assigned: [{ n, filename: name, words, uploadId: upload.id }],
  };
}

/**
 * A file whose name carries no chapter is taken as the complete document and split. Only
 * the chapters this examination covers are loaded. Chapters it does not cover, chapters it
 * expected and did not find, and the front and back matter left out are all reported, so
 * the split can be checked before anything is examined.
 */
async function loadWholeDocument(id, name, file, mode) {
  let found = [];
  let split = null;
  let error = null;
  try {
    split = splitDocument(await extractLines(name, file.buffer));
    found = split.chapters;
  } catch (e) {
    error = e.message;
  }

  const covered = found.filter((c) => mode.chapters.includes(c.n));
  const report = {
    method: split?.method || null,
    chapters: covered.map(({ n, heading, words, pages }) => ({ n, heading, words, pages })),
    outside: found.filter((c) => !mode.chapters.includes(c.n)).map(({ n, heading, words }) => ({ n, heading, words })),
    // Only a gap counts as missing. A dissertation that ends at Chapter 5 is complete, and
    // the examination already covers whichever chapters are present.
    missing: mode.chapters.filter((n) => n < Math.max(0, ...found.map((c) => c.n)) && !found.some((c) => c.n === n)),
    frontMatter: split?.frontMatter || null,
    backMatter: split?.backMatter || [],
  };

  const upload = await store.saveUpload(id, {
    filename: name,
    buffer: file.buffer,
    kind: "document",
    mimetype: file.mimetype,
    error,
    split: report,
  });
  for (const c of covered) await store.writeArtifact(id, store.ARTIFACT_FILES.chapter(c.n), c.text);

  return {
    filename: name,
    kind: "document",
    error,
    uploadId: upload.id,
    split: report,
    assigned: covered.map((c) => ({
      n: c.n,
      filename: name,
      words: c.words,
      uploadId: upload.id,
      heading: c.heading,
      ...(c.pages ? { pages: c.pages } : {}),
    })),
  };
}

app.post(
  "/api/runs/:id/files",
  upload.array("files"),
  wrap(async (req, res) => {
    const id = req.params.id;
    const mode = getMode((await store.readMeta(id)).mode); // 404s early if the run does not exist
    const results = [];

    for (const file of req.files || []) {
      const name = Buffer.from(file.originalname, "latin1").toString("utf8");
      const n = chapterFromFilename(name, mode.chapters);
      results.push(n ? await loadChapterFile(id, name, file, n) : await loadWholeDocument(id, name, file, mode));
    }

    const assigned = results.flatMap((r) => r.assigned || []);

    // Any new chapter text invalidates every derived artifact, so a stale ledger
    // cannot be carried forward into what is effectively a new examination.
    if (assigned.length) await store.invalidateDerived(id);

    await store.updateMeta(id, (m) => {
      for (const a of assigned) {
        const { n, ...info } = a;
        m.chapters[n] = info;
      }
    });

    const meta = await store.readMeta(id);
    res.json({ results, meta });
  }),
);

// ---------- uploaded originals ----------

app.get(
  "/api/runs/:id/uploads",
  wrap(async (req, res) => {
    const meta = await store.readMeta(req.params.id);
    res.json(meta.uploads || []);
  }),
);

app.get(
  "/api/runs/:id/uploads/:uploadId",
  wrap(async (req, res) => {
    const record = await store.findUpload(req.params.id, req.params.uploadId);
    if (!record) return res.status(404).json({ error: "That file is no longer stored." });
    res.download(store.uploadPath(req.params.id, record.storedAs), record.filename);
  }),
);

app.delete(
  "/api/runs/:id/uploads/:uploadId",
  wrap(async (req, res) => {
    const record = await store.deleteUpload(req.params.id, req.params.uploadId);
    if (!record) return res.status(404).json({ error: "That file is no longer stored." });
    res.json({ deleted: record.filename, meta: await store.readMeta(req.params.id) });
  }),
);

app.delete(
  "/api/runs/:id/uploads",
  wrap(async (req, res) => {
    const count = await store.deleteAllUploads(req.params.id);
    res.json({ deleted: count, meta: await store.readMeta(req.params.id) });
  }),
);

/** Assign already-uploaded text to a chapter manually, or paste text directly. */
app.post(
  "/api/runs/:id/chapters/:n",
  wrap(async (req, res) => {
    const n = Number(req.params.n);
    const mode = getMode((await store.readMeta(req.params.id)).mode);
    if (!mode.chapters.includes(n))
      return res.status(400).json({ error: `This examination has no chapter ${req.params.n}.` });
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "No text provided." });

    await store.writeArtifact(req.params.id, store.ARTIFACT_FILES.chapter(n), text);
    await store.invalidateDerived(req.params.id);
    await store.updateMeta(req.params.id, (m) => {
      m.chapters[n] = { filename: req.body?.filename || "(pasted)", words: wordCount(text) };
    });
    res.json({ ok: true, chapter: n, words: wordCount(text) });
  }),
);

// ---------- the cascade ----------

const subscribers = new Map(); // runId -> Set<res>

/**
 * Every event goes to two places: the connected browsers, and the run's events.log.
 * The log is what survives a closed tab, so a failure is still diagnosable afterwards.
 */
function broadcast(runId, event) {
  store.appendEvent(runId, event).catch((err) => {
    console.error(`[${runId}] could not write events.log:`, err.message);
  });

  const set = subscribers.get(runId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) res.write(payload);
}

app.get("/api/runs/:id/events", (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify({ type: "connected", running: pipeline.isRunning(id) })}\n\n`);

  if (!subscribers.has(id)) subscribers.set(id, new Set());
  subscribers.get(id).add(res);

  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    subscribers.get(id)?.delete(res);
  });
});

app.post(
  "/api/runs/:id/examine",
  wrap(async (req, res) => {
    const id = req.params.id;
    if (pipeline.isRunning(id)) return res.status(409).json({ error: "This run is already in progress." });

    const mode = getMode((await store.readMeta(id)).mode);
    const artifacts = await store.loadArtifacts(id);
    const have = mode.chapters.filter((n) => (artifacts.chapters[n] || "").trim());
    if (have.length === 0) return res.status(400).json({ error: "Upload chapter files first." });

    // Fire and forget: the browser follows progress on the SSE stream.
    pipeline
      .runExamination(id, { emit: (e) => broadcast(id, e), force: Boolean(req.body?.force) })
      .catch((err) => broadcast(id, { type: "run:error", error: err.message }));

    res.json({ started: true, chapters: have, units: pipeline.unitList(mode) });
  }),
);

app.post(
  "/api/runs/:id/chapters/:n/:kind",
  wrap(async (req, res) => {
    const { id, kind } = req.params;
    const n = Number(req.params.n);
    const mode = getMode((await store.readMeta(id)).mode);
    if (!mode.chapters.includes(n))
      return res.status(400).json({ error: `This examination has no chapter ${req.params.n}.` });
    if (!["criteria", "review", "oral"].includes(kind))
      return res.status(400).json({ error: "Invalid unit kind." });

    const out = await pipeline.regenerateUnit(id, kind, n);
    broadcast(id, { type: "artifact", kind, chapter: n });
    res.json({ ok: true, content: out });
  }),
);

// ---------- revision round ----------

app.post(
  "/api/runs/:id/revision",
  upload.fields([
    { name: "revised", maxCount: 1 },
    { name: "response", maxCount: 1 },
  ]),
  wrap(async (req, res) => {
    const id = req.params.id;
    const out = {};
    for (const [field, target] of [
      ["revised", store.SINGLETON_FILES.revisedText],
      ["response", store.SINGLETON_FILES.responseText],
    ]) {
      const file = req.files?.[field]?.[0];
      if (!file) continue;
      const name = Buffer.from(file.originalname, "latin1").toString("utf8");
      const upload = await store.saveUpload(id, {
        filename: name,
        buffer: file.buffer,
        kind: field,
        mimetype: file.mimetype,
      });
      const text = await extractText(name, file.buffer);
      await store.writeArtifact(id, target, text);
      out[field] = { filename: name, words: wordCount(text), uploadId: upload.id };
    }
    res.json(out);
  }),
);

app.post(
  "/api/runs/:id/revision/:kind",
  wrap(async (req, res) => {
    const { id, kind } = req.params;
    const meta = await store.readMeta(id);
    const mode = getMode(meta.mode);
    const a = await store.loadArtifacts(id);

    const criteriaBundle =
      mode.chapters
        .filter((n) => a.criteria[n])
        .map((n) => `Chapter ${n} (${mode.descriptions[n].name}) criteria:\n${a.criteria[n]}`)
        .join("\n\n") || "(no prior criteria available)";
    const priorFinalReview = a.finalReview || "(no prior final review available)";

    if (!a.revisedText)
      return res.status(400).json({ error: `Upload the revised ${mode.shortNoun} first.` });

    if (kind === "assessment") {
      const text = await prompts.generateRevisedAssessment(
        mode,
        a.revisedText,
        meta.title,
        criteriaBundle,
        priorFinalReview,
        meta.chairConcerns,
      );
      await store.writeArtifact(id, store.SINGLETON_FILES.revisedAssessment, text);
      return res.json({ ok: true, content: text });
    }

    if (kind === "response") {
      if (!a.responseText)
        return res.status(400).json({ error: "Upload the candidate response letter first." });
      const text = await prompts.evaluateCandidateResponse(
        mode,
        a.responseText,
        priorFinalReview,
        a.revisedText,
        criteriaBundle,
        meta.chairConcerns,
      );
      await store.writeArtifact(id, store.SINGLETON_FILES.responseEvaluation, text);
      return res.json({ ok: true, content: text });
    }

    return res.status(400).json({ error: "Unknown revision artifact." });
  }),
);

// ---------- analytics ----------

app.get(
  "/api/runs/:id/analytics",
  wrap(async (req, res) => {
    const a = await store.loadArtifacts(req.params.id);
    const meta = await store.readMeta(req.params.id);
    const mode = getMode(meta.mode);
    const recurrences = recurrenceMap(a.reviews);

    const rows = [];
    for (const n of mode.chapters) {
      for (const row of parseLedger(a.ledger[n] || "")) {
        rows.push({ ...row, raisedIn: n, recursIn: recurrences[row.id] || [] });
      }
    }
    const restatementsAvoided = rows.reduce((sum, r) => sum + r.recursIn.length, 0);

    res.json({
      totalWords: mode.chapters.reduce((s, n) => s + wordCount(a.chapters[n] || ""), 0),
      chaptersLoaded: mode.chapters.filter((n) => a.chapters[n]).length,
      chapterCount: mode.chapters.length,
      ledger: rows,
      restatementsAvoided,
      units: meta.units || {},
      concurrency: meta.concurrency || null,
      elapsedMs: meta.elapsedMs || null,
      errors: meta.errors || [],
    });
  }),
);

// ---------- package export ----------

app.get(
  "/api/runs/:id/package",
  wrap(async (req, res) => {
    const meta = await store.readMeta(req.params.id);
    const mode = getMode(meta.mode);
    const a = await store.loadArtifacts(req.params.id);
    const rule = "=".repeat(50);
    const section = (heading, body) => [rule, heading, rule, body || "N/A"].join("\n");
    const upper = mode.shortNoun.toUpperCase();

    const parts = [
      `${mode.heading.toUpperCase()} PACKAGE`,
      `Generated: ${meta.finishedAt || meta.createdAt}`,
      `${mode.label}: ${meta.title || "Untitled"}`,
      `Examination Focus: ${meta.chairConcerns?.trim() || "Not specified"}`,
      `Model: ${meta.model} (reasoning effort: ${meta.reasoningEffort})`,
      section(`${upper} SUMMARY`, a.summary),
      ...mode.chapters
        .filter((n) => a.criteria[n] || a.reviews[n])
        .flatMap((n) => [
          section(`CHAPTER ${n} (${mode.descriptions[n].name}) — CRITERIA`, a.criteria[n]),
          section(`CHAPTER ${n} (${mode.descriptions[n].name}) — REVIEW`, a.reviews[n]),
        ]),
      section("FINAL COMPREHENSIVE REVIEW", a.finalReview),
      section("DECISION LETTER", a.decisionLetter),
      section("SUPERVISOR FEEDBACK BRIEF", a.supervisorFeedback),
      section("OVERARCHING ORAL DEFENCE QUESTIONS", a.overallOral),
    ];

    const slug = (meta.title || mode.shortNoun).replace(/[^\w]+/g, "_").slice(0, 60);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_examination_package.txt"`);
    res.send(parts.join("\n\n"));
  }),
);

/**
 * Any generated artifact as a designed Word or PDF document, or its Markdown source.
 * The key is an artifact such as `review-2` or `finalReview`, or `package` for all of it.
 */
app.get(
  "/api/runs/:id/export/:key.:format",
  wrap(async (req, res) => {
    const { id, key, format } = req.params;
    if (!EXPORT_FORMATS[format]) return res.status(400).json({ error: "Unknown export format." });

    const out = await exportArtifact(await store.readMeta(id), await store.loadArtifacts(id), key, format);
    if (!out) return res.status(404).json({ error: "That artifact has not been generated yet." });

    res.setHeader("Content-Type", out.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }),
);

// ---------- errors ----------

app.use((err, req, res, _next) => {
  const status = err.code === "ENOENT" ? 404 : 500;
  // The caller gets the message; the terminal gets the trace, or nothing is diagnosable.
  // A missing file is an ordinary 404 and needs one line; anything else gets the stack.
  console.error(
    `[${new Date().toISOString()}] ${status} ${req.method} ${req.originalUrl} — ${err.message || err}`,
  );
  if (status !== 404) console.error(err.stack || err);
  res.status(status).json({ error: err.message || "Internal error" });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Doctoral Examiner running at http://${HOST}:${PORT}`);
  console.log(`Model: ${llm.MODEL}  ·  reasoning effort: ${llm.REASONING_EFFORT}  ·  concurrency: ${llm.MAX_CONCURRENT_CALLS}`);
  if (!process.env.OPENAI_API_KEY) console.warn("WARNING: OPENAI_API_KEY is not set.");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use, most likely by an earlier copy of this app.`);
    console.error(`Stop it with:   lsof -ti :${PORT} | xargs kill`);
    console.error(`Or use another port:   PORT=8021 npm start\n`);
    process.exit(1);
  }
  throw err;
});

// Ctrl-C should close the SSE streams and exit cleanly rather than leaving the port held.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const set of subscribers.values()) for (const res of set) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
