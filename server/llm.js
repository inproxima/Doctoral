/** OpenAI client wrapper: one place for model, reasoning effort, concurrency, and retries. */
import "dotenv/config";
import OpenAI from "openai";

import { composeSystem } from "./style.js";

export const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";
export const REASONING_EFFORT = process.env.REASONING_EFFORT || "high";
export const MAX_CONCURRENT_CALLS = Number(process.env.MAX_CONCURRENT_CALLS || 4);
export const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 16000);

const MAX_ATTEMPTS = 4;

let _client = null;

function client() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

/**
 * Promise semaphore — the equivalent of asyncio.Semaphore in the Python original.
 * Every model call passes through it, so the fan-out in pipeline.js can be as wide
 * as the dependency graph allows without exceeding MAX_CONCURRENT_CALLS in flight.
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };

  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });

  run.inFlight = () => active;
  run.queued = () => queue.length;
  return run;
}

export const limit = createLimiter(MAX_CONCURRENT_CALLS);

/** Peak concurrency actually reached, so the parallelism claim can be verified. */
export const stats = { peakInFlight: 0, calls: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const code = err?.code || err?.cause?.code;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND"].includes(code);
}

function mentionsReasoning(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 400 && /reasoning/i.test(String(err?.message || ""));
}

/**
 * The API reports a context overflow without saying how much was sent, which leaves
 * "adjust your input" as the only guidance. Attaching the size turns an opaque 400 into
 * a number the run log can be read against — a chapter that arrives an order of magnitude
 * larger than its word count is carrying something other than prose.
 */
function annotateOverflow(err, system, user) {
  if (!/context window|context length|too many tokens|maximum context/i.test(String(err?.message || ""))) {
    return err;
  }
  const chars = system.length + user.length;
  err.message =
    `${err.message} ` +
    `[input was ${(chars / 1024).toFixed(0)} KB, roughly ${Math.round(chars / 4).toLocaleString()} tokens]`;
  return err;
}

/**
 * Call the model with high reasoning effort. Returns the output text.
 *
 * Models that do not accept the reasoning parameter are retried without it, matching
 * the fallback in Grading/backend/llm.py. Rate limits and transient server errors are
 * retried with exponential backoff, which the sequential Python original never needed.
 */
export async function callModel(system, user, { maxOutputTokens = MAX_OUTPUT_TOKENS } = {}) {
  return limit(async () => {
    stats.calls += 1;
    stats.peakInFlight = Math.max(stats.peakInFlight, limit.inFlight());

    const request = {
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_output_tokens: maxOutputTokens,
      reasoning: { effort: REASONING_EFFORT },
    };

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const resp = await client().responses.create(request);
        const text = (resp.output_text || "").trim();
        if (!text) throw new Error(`Model returned no text (status: ${resp.status || "unknown"}).`);
        return text;
      } catch (err) {
        lastError = err;
        if (mentionsReasoning(err) && request.reasoning) {
          delete request.reasoning;
          continue;
        }
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw annotateOverflow(err, system, user);
        await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 400);
      }
    }
    throw lastError;
  });
}

/** The single entry point every prompt builder uses, so the style is never bypassed. */
export async function ask(prompt, { role, maxOutputTokens } = {}) {
  return callModel(composeSystem(role), prompt, { maxOutputTokens });
}
