// Defects found by the adversarial verification that are not fixed yet: they only assert with ADVERSARIAL_STRICT=1.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fitBody } from "../../site/js/human/fit.js";
import { subjectProfile } from "../../site/js/human/anthro.js";
import { buildSkin } from "../../site/js/human/body.js";
import { makeBones, DB_PATH } from "./body.adversarial.helpers.mjs";

const STRICT = process.env.ADVERSARIAL_STRICT === "1";

test("KNOWN DEFECT (strict): low quality stays under 20,000 triangles for tall people (1.3 % of the 13,792 subjects exceed it, up to 21,200 at 1.95 m)", { skip: !STRICT }, () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const tall = db.prepare("select * from subjects where dataset = 'ansur_1988' and subject_key = ?").get("412"); // 2012 mm
  const b = fitBody(subjectProfile(tall)), sk = buildSkin(b, makeBones(b), { quality: "low" });
  assert.ok(sk.stats.triangles < 20000, `${sk.stats.triangles} triangles for a ${b.stature} m person`);
  sk.dispose();
});

test("KNOWN DEFECT (strict, low): buildSkin(body, bones, null) does not throw (the default value only covers undefined)", { skip: !STRICT }, () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const b = fitBody(subjectProfile(db.prepare("select * from subjects limit 1").get())), sk = buildSkin(b, makeBones(b), null);
  assert.ok(sk.mesh);
  sk.dispose();
});
