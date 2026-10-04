// Reports how many measures in aggregates/rollup.csv have a specific marker on the body map (site/js/bodymarks.js).
// Usage: node scripts/check_body_marks.mjs   (Node 22+, which loads the site's ES modules without a package.json flag)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolve } = await import(pathToFileURL(path.join(root, "site/js/bodymarks.js")).href);

function csvRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  return rows;
}

const rows = csvRows(fs.readFileSync(path.join(root, "aggregates/rollup.csv"), "utf8"));
const head = rows[0], ik = head.indexOf("measure_key"), il = head.indexOf("measure_label");
const measures = new Map();
for (const r of rows.slice(1)) if (r[ik]) measures.set(r[ik], (measures.get(r[ik]) || [0, r[il]]).map((v, i) => i ? v : v + 1));

const missing = [], failed = [];
let exact = 0;
for (const [key, [n, label]] of measures) {
  for (const sex of ["M", "F"]) {
    try {
      const s = resolve(key, sex);
      if (sex === "M") { if (s.kind === "exact") exact++; else missing.push(`${key} (${label}, ${n} rows) -> ${s.kind}`); }
      else if (s.kind === "exact" && !s.m.length && !s.tint) failed.push(`${key}: empty marker for ${sex}`);
    } catch (e) { failed.push(`${key} ${sex}: ${e.message}`); }
  }
}
console.log(`${exact} of ${measures.size} measures have a specific marker on the body map`);
if (missing.length) console.log("Without one:\n  " + missing.join("\n  "));
if (failed.length) { console.error("Errors:\n  " + failed.join("\n  ")); process.exit(1); }
