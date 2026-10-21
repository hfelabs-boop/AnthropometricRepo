import * as P from "../../site/js/human/panels/profile.js";
import * as S from "../../site/js/human/panels/skeleton.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
const fin = (o, p = "", out = [], d = 0) => { if (d > 7 || o == null) return out; if (typeof o === "number") { if (!Number.isFinite(o)) out.push(p); } else if (typeof o === "object") for (const [k, v] of Object.entries(o)) fin(v, p + "." + k, out, d + 1); return out; };
let n = 0, bad = 0, errs = new Map();
for (const sex of ["M", "F", "both"]) for (const st of ["1300", "1301", "1500", "1750", "2100", "2499", "2500", "1,755", "175,5"]) for (const [ms, mu] of [["", "kg"], ["20", "kg"], ["40", "kg"], ["80", "kg"], ["250", "kg"], ["499", "kg"], ["500", "kg"], ["1", "kg"], ["0", "kg"], ["176", "lb"], ["1100", "lb"], ["-5", "kg"]]) {
  for (const stU of st.includes(",") ? ["mm"] : ["mm"]) {
    n++;
    let p;
    try { p = P.manualFromForm({ sex, stature: st, statureUnit: stU, mass: ms, massUnit: mu }); } catch (e) { errs.set(e.message.slice(0, 80), (errs.get(e.message.slice(0, 80)) ?? 0) + 1); continue; }
    const f = P.finalizeProfile(p, {});
    let b;
    try { b = fitBody(f, { form: P.defaultForm(f) }); } catch (e) { console.log("FIT THROW", sex, st, ms, mu, e.message); bad++; continue; }
    const nan = [...fin(b.joints, "joints"), ...fin(b.dims, "dims"), ...fin(b.landmarks, "lm"), ...fin(b.report, "report"), ...fin(b.shape, "shape")];
    if (nan.length) { console.log("NaN", sex, st, ms, mu, nan.slice(0, 3)); bad++; }
    if (b.warnings.length > 0 && n % 17 === 0) console.log("warnings", sex, st, ms, mu, b.warnings.slice(0, 2).map((w) => w.slice(0, 90)));
    // skeleton helpers on that body
    for (const j of ["pelvis", "ankle_L", "shoulder_R", "C7"]) { const m = S.restSegmentMm(j, b); if (!Number.isFinite(m)) { console.log("restSegment NaN", j); bad++; } }
    const ids = Object.keys(b.landmarks); if (ids.length < 100) console.log("few landmarks", ids.length);
  }
}
console.log("built", n, "bad", bad, "errors", [...errs]);
