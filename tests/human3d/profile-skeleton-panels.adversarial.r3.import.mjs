// Hostile and odd import files -> parseImport -> finalizeProfile -> fitBody -> dimensionRows: no throw other than a plain Error from parseImport, no NaN/Infinity in the body, bounded time.
import * as P from "../../site/js/human/panels/profile.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
const big = (n) => "key,value,unit\nstature,1750,mm\n" + Array.from({ length: n }, (_, i) => `other:k${i},${i + 1},mm`).join("\n");
const corpus = {
  bom: "﻿key,value,unit\r\nstature,1750,mm\r\nmass,78,kg\r\n",
  semicolon: "key;value;unit\nstature;1750;mm\nmass;78;kg\n",
  decimalComma: "key;value;unit\nstature;1750,5;mm\nmass;78,2;kg\n",
  tsv: "key\tvalue\tunit\nstature\t175\tcm\nmass\t170\tlb\n",
  proto: '{"__proto__":{"stature":{"value":1}},"stature":1750,"constructor":{"prototype":{"x":1}},"mass":"80 kg"}',
  protoCsv: "key,value,unit\n__proto__,5,mm\nconstructor,5,mm\nstature,1750,mm\nhasOwnProperty,3,mm\n",
  negative: "key,value,unit\nstature,-1750,mm\nmass,-3,kg\n",
  huge: "key,value,unit\nstature,1e308,mm\n",
  tiny: "key,value,unit\nstature,1e-300,mm\n",
  nan: "key,value,unit\nstature,NaN,mm\n",
  inf: "key,value,unit\nstature,Infinity,mm\n",
  hexnum: "key,value,unit\nstature,0x6D6,mm\n",
  strstature: '{"stature":"abc"}',
  nested: '{"measures":{"stature":{"value":1750,"unit":"mm"},"sitting_height":{"value":"x"}}}',
  arr: '[{"key":"stature","value":1750,"unit":"mm"},null,5,"x",{"key":null}]',
  deepjson: "[".repeat(5000) + "]".repeat(5000),
  html: "<!doctype html><html><body>stature 1750</body></html>",
  onlyheader: "key,value,unit\n",
  quoted: 'key,value,unit\n"stature",1750,"mm"\n"mass,x",80,kg\n',
  multi: "key,value,unit\nstature,1750,mm\nstature,1800,mm\n",
  unitMismatch: "key,value,unit\nstature,1750,kg\n",
  bigkeys: big(20000),
  longkey: "key,value,unit\nstature,1750,mm\n" + "a".repeat(100000) + ",5,mm\n",
  formula: "key,value,unit\n=cmd|' /C calc'!A0,5,mm\nstature,1750,mm\n",
  populationFile: JSON.stringify({ population: { country: "<img src=x onerror=alert(1)>", role: "r", sex: "M" }, measures: [{ key: "stature", p5: 1600, p50: 1750, p95: 1900, unit: "mm", n: 10 }] }),
  mannequin: JSON.stringify({ sex: "M", measures: { stature: { value: 1750, unit: "mm" } }, label: "x".repeat(10000) }),
  label: JSON.stringify({ stature: 1750, label: "</script><b>x</b>", sex: "Z" }),
  sexF: JSON.stringify({ stature: 1750, sex: "female" }),
  statureM: "key,value,unit\nstature,1.75,m\n", statureOnly: "1750", empty: "", ws: "   \n\n",
  lb: "key,value,unit\nstature,69,in\nmass,176,lb\n",
  outOfBand: "key,value,unit\nstature,1750,mm\nhand_length,900,mm\nfoot_length,50,mm\nsitting_height,2500,mm\n",
};
let bad = 0;
const scan = (o, path, seen = new Set()) => { if (o && typeof o === "object") { if (seen.has(o)) return; seen.add(o); for (const [k, v] of Object.entries(o)) scan(v, path + "." + k, seen); } else if (typeof o === "number" && !Number.isFinite(o)) { console.log("  NON-FINITE at", path, o); bad++; } };
for (const [name, text] of Object.entries(corpus)) {
  const t0 = performance.now();
  let prof;
  try { prof = anthro.parseImport(text, name + ".csv", { minReliability: "medium" }); } catch (e) { console.log(name.padEnd(14), "parse error:", String(e.message).slice(0, 110), e instanceof Error ? "" : "NOT AN ERROR"); continue; }
  try {
    const f = P.finalizeProfile(prof, {});
    const b = fitBody(f, { form: P.defaultForm(f) });
    scan(b.joints, "joints"); scan(b.dims, "dims"); scan(b.landmarks, "landmarks"); scan(b.report, "report");
    const rows = P.dimensionRows(b, f);
    const label = f.label;
    console.log(name.padEnd(14), "OK stature", (b.stature * 1000).toFixed(1), "mass", b.mass?.toFixed(1), "measures", Object.keys(f.measures).length, "rows", rows.length, "label", JSON.stringify(label).slice(0, 60), `${(performance.now() - t0).toFixed(0)}ms`, "protoPolluted:", ({}).stature !== undefined || ({}).x !== undefined);
  } catch (e) { console.log(name.padEnd(14), "PIPELINE THROW:", e.stack.split("\n").slice(0, 3).join(" | ")); bad++; }
}
console.log("bad", bad);
