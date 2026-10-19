#!/usr/bin/env node
/** Import every server module so syntax errors and bad imports surface without an API key. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(ROOT, "server");

// Recursive, so modules in subfolders such as server/export are checked too. server/index.js
// is skipped because importing it starts the server.
const modules = (await fs.readdir(dir, { recursive: true }))
  .filter((f) => f.endsWith(".js") && f !== "index.js")
  .sort();

let failed = 0;
for (const name of modules) {
  try {
    await import(pathToFileURL(path.join(dir, name)).href);
    console.log(`✅ server/${name}`);
  } catch (err) {
    failed += 1;
    console.log(`❌ server/${name}  ${err.message}`);
  }
}
console.log(failed === 0 ? "\nAll modules load." : `\n${failed} module(s) failed to load.`);
process.exit(failed === 0 ? 0 : 1);
