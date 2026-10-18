#!/usr/bin/env node
// Prints the table of joint angles (key DOF, meaning of + and -, range) of the Digital human rig as Markdown, generated from
// site/js/human/skeleton.js so that it cannot drift from the code. The output is pasted into docs/human3d/POSE.md between the markers
// <!-- dof-table:begin --> and <!-- dof-table:end -->; tests/human3d/pose.test.mjs fails when the document is out of date.
//   node scripts/human_dof_table.mjs            # print to stdout (works standalone: it registers the loader for `three` itself)
// Regenerate the document section:   node scripts/human_dof_table.mjs --update-docs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

// skeleton.js imports the bare specifier "three" (the browser's import map): register the test loader that maps it to the vendored build
register("../tests/human3d/resolve-hooks.mjs", import.meta.url);
const { JOINTS, REGIONS, ROOT_DOF } = await import("../site/js/human/skeleton.js");

const num = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(1)));
const range = (d) => `${num(d.min)} to ${num(d.max)}`;
const row = (...c) => `| ${c.join(" | ")} |`;

/** The Markdown table (a string ending in a newline). */
export function dofTable() {
  const out = [row("Joint key in a posture", "Index", "DOF", "Positive means", "Negative means", "Range (deg)"), row("---", "---", "---", "---", "---", "---")];
  // root: heading is a yaw about the world vertical; flex / lat / rot are the pelvis swing-twist
  ROOT_DOF.forEach((d) => out.push(row("`root`", "-", `\`${d.key}\``, d.pos, d.neg, `${range(d)}${d.key === "heading" ? "" : " (not limited)"}`)));
  // spine regions: totals over the region, relative to the natural standing curvature
  for (const r of Object.values(REGIONS)) {
    [["flex", "forward bend", "extension", r.range.flex], ["lat", "bend to the figure's left", "bend to the right", r.range.lat], ["rot", "turn to the figure's left", "turn to the right", r.range.rot]].forEach(([k, p, n, rg], i) =>
      out.push(row(`\`spine.${r.id}\``, String(i), `\`${k}\``, p, n, `${num(rg[0])} to ${num(rg[1])} (total over ${r.joints.length} vertebrae)`)));
  }
  // joints: left side / unpaired, fingers of the same table merged
  const seen = new Map();
  for (const j of JOINTS) {
    if (j.id === "pelvis" || j.side === "R" || j.region) continue;
    const key = j.side === "L" ? `${j.id.slice(0, -2)}_LR` : j.id;
    seen.set(key, j);
  }
  const FINGER = /^(index|middle|ring|little)_(mcp|pip|dip)_LR$/;
  const printed = new Set();
  for (const [key, j] of seen) {
    let label = `\`${key}\``;
    const m = FINGER.exec(key);
    if (m) {
      if (m[1] !== "index") continue;
      label = `\`{index,middle,ring,little}_${m[2]}_LR\``;
    }
    if (printed.has(label)) continue;
    printed.add(label);
    j.dof.forEach((d, i) => {
      let { pos, neg } = d;
      if (key === "eye_LR" && d.key === "azim") { pos = "gaze toward the figure's left (both eyes; the right eye's joint angle is the negation, expandSides)"; neg = "gaze toward the figure's right"; }
      out.push(row(label, String(i), `\`${d.key}\``, pos, neg, range(d)));
    });
  }
  return out.join("\n") + "\n";
}

const BEGIN = "<!-- dof-table:begin -->", END = "<!-- dof-table:end -->";
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--update-docs")) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "human3d", "POSE.md");
    const text = fs.readFileSync(file, "utf8");
    const a = text.indexOf(BEGIN), b = text.indexOf(END);
    if (a < 0 || b < a) throw new Error(`${file} lacks the markers ${BEGIN} ... ${END}`);
    fs.writeFileSync(file, text.slice(0, a + BEGIN.length) + "\n" + dofTable() + text.slice(b));
    console.log(`updated ${file}`);
  } else process.stdout.write(dofTable());
}
