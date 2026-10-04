// Where each measure is taken on the body figures: landmarks measured on the two CC0 meshes (bodydata.js) plus the survey
// means themselves (proportions of stature / sitting height) place a dimension line, circumference, arc or site marker for
// each measure. Everything is in SVG units, 440 per stature, floor at y=450 in the standing views.
import { DATA } from "./bodydata.js";

export const CX = 100, SEAT = 258;
export const Y = f => 450 - 440 * f;
const near = (o, y) => { y = Math.round(y / 2) * 2; for (let d = 0; d <= 60; d += 2) { const v = o[y + d] || o[y - d]; if (v) return v; } return null; };
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const unit = v => { const n = Math.hypot(v[0], v[1]) || 1; return [v[0] / n, v[1] / n]; };
const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

// ---- marker constructors -------------------------------------------------------------------------
const vdim = (x, y1, y2, leads = [], dots = []) => ({ k: "v", x, y1, y2, leads, dots });
const hdim = (y, x1, x2, leads = [], dots = []) => ({ k: "h", y, x1, x2, leads, dots });
const odim = (p, q, leads = [], dots = [p, q]) => ({ k: "d", x1: p[0], y1: p[1], x2: q[0], y2: q[1], leads, dots });
const circ = (cx, cy, rx, ry = rx * .2, v = false) => ({ k: "c", cx, cy, rx, ry, v });
const trace = (pts, dots) => ({ k: "p", pts, dots: dots || [pts[0], pts[pts.length - 1]], leads: [] });
const archq = (p, q, apexY, dots = [p, q]) => ({ k: "a", x1: p[0], y1: p[1], x2: q[0], y2: q[1], rx: Math.abs(q[0] - p[0]) / 2, ry: Math.max(2, Math.abs(apexY - (p[1] + q[1]) / 2)), up: apexY < (p[1] + q[1]) / 2, dots, leads: [] });
const site = (x, y) => ({ k: "s", x, y });
const wallm = (x, y1, y2) => ({ k: "w", x, y1, y2 });
const region = (cx, cy, rx, ry) => ({ k: "r", cx, cy, rx, ry });
const P = (pose, desc, ...m) => ({ pose, desc, m: m.flat() });
const TINT = desc => ({ pose: "stand", desc, m: [], tint: true });

const cache = {};
export function marksFor(sex) { const s = sex === "F" ? "F" : "M"; return cache[s] || (cache[s] = build(s)); }

function build(sex) {
  const D = DATA[sex], L = D.L, G = D.G, H = D.head, A = D.arms, W = D.wall, u = L.u;
  const dz = G.eye[1] - L.eyeY, dxs = D.dxs, sH = SEAT - G.headTop[1];
  const other = sex === "M" ? "F" : "M";
  const FR = (keys, i, d) => { for (const k of [].concat(keys)) { const e = DATA.FR[k]; if (!e) continue; const v = (e[sex] || e[other] || [])[i]; if (v != null) return v; } return d; };
  const yS = (keys, d) => Y(FR(keys, 0, d));                  // standing level from the survey mean
  const yQ = (keys, d) => SEAT - FR(keys, 1, d) * sH;         // seated level from the survey mean
  const wS = (keys, d) => FR(keys, 0, d) * 440;               // a length as SVG units

  // ---- silhouette helpers (standing front / back) ----------------------------------------------
  const keys = Object.keys(D.runs).map(Number).sort((a, b) => a - b);
  const rowRuns = y => D.runs[keys.reduce((best, k) => Math.abs(k - y) < Math.abs(best - y) ? k : best, keys[0])];
  const midRun = y => rowRuns(y).find(([a, b]) => a <= CX && CX <= b) || [CX - 30, CX + 30];
  const right = y => rowRuns(y).filter(([a, b]) => a > CX || (a + b) / 2 > CX + 1);
  const outer = y => { const [a, b] = midRun(y); return (b - a) / 2; };
  const hw = y => { const v = near(D.tw, y); return v == null ? 40 : v; };
  const leg = y => { const r = right(y).filter(([a, b]) => (a + b) / 2 < 152 && b > CX); return r.length ? r.reduce((p, q) => Math.abs((q[0] + q[1]) / 2 - 130) < Math.abs((p[0] + p[1]) / 2 - 130) ? q : p) : [CX + 8, CX + 38]; };
  const legC = y => { const [a, b] = leg(y); return [(a + b) / 2, (b - a) / 2]; };

  // ---- arms and hands in each pose ---------------------------------------------------------------
  const HL = .108 * 440;
  const arm = (key, mirror = false) => {
    const a = A[key], mx = p => mirror ? [200 - p[0], p[1]] : p;
    const sh = mx(a.sh), el = mx(a.el), jt = mx(a.wr), tip = mx(a.tip), fd = unit([jt[0] - el[0], jt[1] - el[1]]);
    const wrist = [jt[0] - fd[0] * .4 * HL, jt[1] - fd[1] * .4 * HL];
    const along = t => lerp(wrist, tip, t);
    return { sh, el, wrist, tip, along, grip: along(.47), mc3: along(.465), thumb: along(.82), len: dist(wrist, tip), dir: unit([tip[0] - wrist[0], tip[1] - wrist[1]]),
      // point on the upper-arm / forearm axis
      ua: t => lerp(sh, el, t), fa: t => lerp(el, wrist, t) };
  };
  const af = arm("stand:front"), ar = arm("reach:side"), au = arm("up:side"), aq = arm("sit:sit"), aqu = arm("situp:sit");
  const armX = y => { const pts = [af.sh, af.el, af.wrist, af.tip]; for (let i = 0; i < 3; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[i + 1]; if (y <= y1 || i === 2) return x0 + (x1 - x0) * Math.min(1, Math.max(0, (y - y0) / (y1 - y0))); } };
  const armHalf = (y, dflt) => { const r = right(y).filter(([a, b]) => (a + b) / 2 > armX(y) - 12 && (a + b) / 2 < armX(y) + 12); return r.length ? (r[0][1] - r[0][0]) / 2 : dflt; };

  // ---- standing levels ------------------------------------------------------------------------------
  const headHalf = outer(L.eyeY - 9);
  const [yBid, hBid] = (() => { let best = [90, 0]; for (let y = 84; y <= 120; y += 2) if (outer(y) > best[1]) best = [y, outer(y)]; return best; })();
  const lv = {
    vertex: 10, eye: L.eyeY, cervicale: yS("cervicale_height", .855), t2: yS("other:t2_height", .8375), suprasternale: yS("suprasternale_height", .818), acromion: L.acromionY,
    midshoulder: Y(.845), axilla: yS("other:axilla_height", .7557), substernale: yS("other:substernale_height", .7074), scye: yS("other:axilla_height", .7557) + 2,
    bust: yS(["other:breast_height", "other:chest_height", "other:nipple_height", "other:bustpoint_height", "other:nipple_chest_height"], .73), tenthRib: yS("other:tenth_rib_height", .6393),
    navel: yS("other:waist_height_omphalion", .6041), waist: L.waistY, iliocristale: yS("iliocristale_height", .6065), iliospinale: Y(.57), trochanter: yS("trochanterion_height", .5228),
    buttock: yS("other:buttock_height", .5086), crotch: L.crotchY, gluteal: yS("other:gluteal_furrow_height", .4578),
    patella: yS(["other:patella_top_height", "other:kneecap_height"], .296), knee: L.kneeY, tibiale: yS(["other:tibiale_height", "other:tibial_height"], .27), calf: yS("other:calf_height", .2028),
    ankle: L.ankleY, malleolusL: yS("other:lateral_malleolus_height", .0409), malleolusM: yS("other:medial_malleolus_height", .049), sphyrion: yS("other:sphyrion_height", .0399),
    wrist: af.wrist[1], stylion: af.wrist[1] + 2, olecranon: af.el[1] - 2, elbow: af.el[1] - 6, dactylion: af.tip[1], mc3: af.mc3[1],
    tragion: H.tragion[1] - dz, menton: H.menton[1] - dz, bigon: H.menton[1] - dz - 11,
  };
  lv.neck = lv.menton + 9;
  const side = (y, rear = 1) => { const t = near(D.ts, y); return t ? t[rear ? 1 : 0] : (rear ? 80 : 135); };   // standing side silhouette
  const sitSide = (y, rear = 1) => { const t = near(D.td, y - dz); return t ? t[rear ? 1 : 0] : (rear ? 70 : 130); };    // seated side silhouette (rows are stored by standing y)

  // ---- head landmarks in the seated side frame (x, y); stand frame uses y - dz and x + dxs ----------------
  const hp = {
    vertex: G.headTop, glabella: H.glabella, sellion: H.sellion, nasion: H.sellion, pronasale: H.pronasale, subnasale: H.subnasale, labrale_sup: H.labrale_sup,
    stomion: H.stomion, labrale_inf: H.labrale_inf, pogonion: H.pogonion, menton: H.menton, tragion: H.tragion, opisthocranion: H.opisthocranion,
    ectocanthus: [H.sellion[0] - 2.5, G.eye[1] - .3], cheilion: [H.stomion[0] - 5, H.stomion[1]], alare: [H.pronasale[0] - 4.5, H.subnasale[1] - 1.6],
    infraorbitale: [H.sellion[0] - 7, G.eye[1] + 5.3], zygion: [H.tragion[0] + 13, G.eye[1] + 3.5], zygofrontale: [H.glabella[0] - 9, G.eye[1] - 9.5], frontotemporale: [H.glabella[0] - 10, G.eye[1] - 12],
    gonion: [H.tragion[0] + 9, H.menton[1] - 11], crinion: [H.glabella[0] - 2, H.menton[1] - 49.5], inion: [H.opisthocranion[0] + 1, H.inion_y], nuchale: [H.opisthocranion[0] + 6, H.inion_y + 14],
    ectoorbitale: [H.sellion[0] - 2.5, G.eye[1] - .3], earTop: [H.ear_outer + 4, H.ear_top], earBottom: [H.ear_outer + 8, H.ear_bottom],
  };
  const hpy = n => hp[n][1], hpx = n => hp[n][0];
  const outline = H.outline;
  const along = (a, b) => {                       // part of the head outline between two landmarks, nearest outline points
    const near1 = p => outline.reduce((best, q, i) => (dist(p, q) < best[0] ? [dist(p, q), i] : best), [1e9, 0])[1];
    let i = near1(a), j = near1(b); const pts = i <= j ? outline.slice(i, j + 1) : outline.slice(j, i + 1).reverse(); return pts;
  };
  // half-widths seen from the front (survey means: breadth / 2 as SVG units), fallback proportions
  const hwid = (keys, d) => wS(keys, d / 440) / 2;
  const fw = {
    bitragion: hwid(["bitragion_breadth", "other:bitragion_breadth", "other:biauricular_breadth", "other:ear_to_ear_breadth"], 2 * (headHalf - 1)), biocular: hwid(["other:biocular_breadth"], 2 * 12.5),
    interocular: hwid(["other:interocular_breadth"], 2 * 4.3), bigonial: hwid(["other:bigonial_breadth"], 2 * 14), bizyg: hwid(["bizygomatic_breadth"], 2 * headHalf * .9),
    nasal: hwid(["other:nasal_breadth", "other:nose_breadth"], 2 * 5), nroot: hwid(["other:nasal_root_breadth"], 2 * 2.6), lip: hwid(["other:lip_length", "other:lip_width"], 2 * 6.8),
    minfr: hwid(["other:minimum_frontal_breadth"], 2 * 13), maxfr: hwid(["other:maximum_frontal_breadth"], 2 * 16.5), pupil: 8,
  };
  const earOut = headHalf + 3.2;                 // outer edge of the ear seen from the front
  const fy = n => hp[n][1] - dz;                  // stand-frame y of a head landmark

  // ---- builders for the standing front / back / side poses -----------------------------------------------
  const hLead = (pose, desc, y, lx, x = 14) => P(pose, desc, vdim(x, y, 450, [[x, y, lx, y]], [[lx, y]]));
  const fHeight = (y, lx, what) => hLead("stand", `Vertical distance from the floor to the ${what}.`, y, lx);
  const bHeight = (y, lx, what) => hLead("back", `Vertical distance from the floor to the ${what}.`, y, lx);
  const sHeight = (y, lx, what) => hLead("side", `Vertical distance from the floor to the ${what}.`, y, lx);
  const breadthF = (y, half, what, pose = "stand") => P(pose, what, hdim(y, CX - half, CX + half, [], [[CX - half, y], [CX + half, y]]));
  const ring = (y, rx, ry, pose = "stand", desc) => P(pose, desc, circ(CX, y, rx, ry));
  const legRing = (y, desc) => { const [c, r] = legC(y); return P("stand", desc, circ(c, y, r)); };
  const armRing = (y, dflt, desc) => P("stand", desc, circ(armX(y), y, armHalf(y, dflt), armHalf(y, dflt) * .22));
  const depthS = (y, desc, pose = "side") => { const f = side(y, 0), r = side(y, 1); return P(pose, desc, hdim(y, r, f, [], [[r, y], [f, y]])); };
  const depthQ = (y, desc) => { const f = sitSide(y, 0), r = sitSide(y, 1); return P("sit", desc, hdim(y, r, f, [], [[r, y], [f, y]])); };
  const surf = (pose, front, y1, y2) => {         // path along the front or rear body surface between two levels
    const fn = pose === "sit" ? sitSide : side, pts = []; const step = y2 > y1 ? 4 : -4;
    for (let y = y1; step > 0 ? y < y2 : y > y2; y += step) pts.push([fn(y, front ? 0 : 1), y]); pts.push([fn(y2, front ? 0 : 1), y2]); return pts;
  };
  const loopPath = (pose, yA, yB, yC) => {         // front surface yA down to the crotch, round, and up the rear to yB
    const fn = pose === "sit" ? sitSide : side;
    return [...surf(pose, true, yA, yC), [fn(yC, 0), yC], [fn(yC, 1), yC], ...surf(pose, false, yC, yB)];
  };

  // ---- seated builders --------------------------------------------------------------------------------
  const seatTo = (x, y, lx, desc) => P("sit", desc, vdim(x, y, SEAT, [[x, y, lx, y]], [[lx, y]]));
  const yf = G.floorY + 14, yBut = L.buttY + dz, pop = [G.kneeJoint[0] - 13, G.kneeJoint[1] + 19];
  const [ex, ey] = G.elbow, [fgx, fgy] = G.finger, yFore = Math.max(fgy, ey) + 14;
  const headX = hp.pronasale[0] + 14;            // dimension line to the right of the face (seated side head view)
  const hV = (a, b, desc, pose = "sit", ox = 0, oy = 0) => {          // vertical head dimension between two landmarks (sit frame)
    const ya = hpy(a) + oy, yb = hpy(b) + oy, x = headX + ox;
    return P(pose, desc, vdim(x, ya, yb, [[x, ya, hpx(a) + ox * 0 + (pose === "side" ? dxs : 0), ya], [x, yb, hpx(b) + (pose === "side" ? dxs : 0), yb]], [[hpx(a) + (pose === "side" ? dxs : 0), ya], [hpx(b) + (pose === "side" ? dxs : 0), yb]]));
  };
  const headWall = H.opisthocranion[0] - 0;       // the wall touches the back of the head
  const toWall = (name, desc) => P("sit", desc || `Horizontal distance from a wall touching the back of the head to the ${name.replace(/_/g, " ")}.`,
    wallm(headWall, hpy(name) - 16, hpy(name) + 16), hdim(hpy(name), headWall, hpx(name), [], [[hpx(name), hpy(name)]]));
  const hHor = (a, b, desc, dy = 0) => P("sit", desc, hdim(Math.min(hpy(a), hpy(b)) - dy, hpx(a), hpx(b), [[hpx(a), hpy(a), hpx(a), Math.min(hpy(a), hpy(b)) - dy], [hpx(b), hpy(b), hpx(b), Math.min(hpy(a), hpy(b)) - dy]], [hp[a], hp[b]]));
  // head breadth, front view
  const fHB = (y, half, desc) => P("stand", desc, hdim(y, CX - half, CX + half, [], [[CX - half, y], [CX + half, y]]));

  // ---- the table -----------------------------------------------------------------------------------------------------------
  const S = {};
  // heights (standing)
  const hv = (key, y, lx, what, f = fHeight) => { S[key] = f(y, lx, what); };
  hv("stature", 10, CX, "top of the head"); hv("cervicale_height", lv.cervicale, CX - hw(lv.cervicale), "cervicale (the bump at the base of the neck)");
  hv("suprasternale_height", lv.suprasternale, CX, "suprasternale (notch at the top of the breastbone)"); hv("acromion_height", lv.acromion, 200 - L.acromionX, "acromion (tip of the shoulder)");
  hv("trochanterion_height", lv.trochanter, CX - outer(lv.trochanter), "trochanterion (top of the hip bone)"); hv("iliocristale_height", lv.iliocristale, CX - hw(lv.iliocristale), "iliocristale (top of the hip crest)");
  hv("crotch_height", lv.crotch, CX, "crotch"); hv("waist_height", lv.waist, CX - hw(lv.waist), "waist (natural indentation)");
  hv("axilla_height", lv.axilla, CX - hw(lv.axilla), "armpit (axilla)"); hv("t2_height", lv.t2, CX, "second thoracic vertebra", bHeight);
  hv("substernale_height", lv.substernale, CX, "substernale (lower tip of the breastbone)"); hv("tenth_rib_height", lv.tenthRib, CX - hw(lv.tenthRib), "tenth rib");
  hv("navel_height", lv.navel, CX, "navel (omphalion)"); hv("iliospinale_height", lv.iliospinale, CX - hw(lv.iliospinale) * .9, "iliospinale (front hip spine)");
  hv("gluteal_furrow_height", lv.gluteal, CX, "gluteal furrow (fold below the buttock)", bHeight);
  hv("bust_height", lv.bust, CX - (wS(["other:bustpoint_bustpoint_breadth", "other:bustpoint_thelion_bustpoint_thelion_breadth"], .1) / 2 || 24), "bust point / nipple");
  S.patella_height = fHeight(lv.patella, 200 - legC(lv.patella)[0], "top of the kneecap");
  S.tibiale_height = fHeight(lv.tibiale, 200 - legC(lv.tibiale)[0] - legC(lv.tibiale)[1], "tibiale (top of the shin bone, inner side of the knee)");
  S.calf_height = fHeight(lv.calf, 200 - legC(lv.calf)[0] - legC(lv.calf)[1], "widest part of the calf");
  S.knee_height = fHeight(lv.knee, 200 - legC(lv.knee)[0] - legC(lv.knee)[1], "middle of the kneecap");
  S.femoral_epicondyle_height = fHeight(lv.knee, 200 - legC(lv.knee)[0] - legC(lv.knee)[1], "outer knuckle of the thigh bone (lateral femoral epicondyle)");
  S.lateral_malleolus_height = fHeight(lv.malleolusL, 200 - legC(lv.malleolusL)[0] - legC(lv.malleolusL)[1], "lateral malleolus (outer ankle bone)");
  S.medial_malleolus_height = fHeight(lv.malleolusM, 200 - legC(lv.malleolusM)[0] + legC(lv.malleolusM)[1], "medial malleolus (inner ankle bone)");
  S.sphyrion_height = fHeight(lv.sphyrion, 200 - legC(lv.sphyrion)[0] + legC(lv.sphyrion)[1], "sphyrion (tip of the inner ankle bone)");
  S.ankle_height = fHeight(lv.ankle, 200 - legC(lv.ankle)[0] - legC(lv.ankle)[1], "ankle");
  S.buttock_height = sHeight(lv.buttock, side(lv.buttock, 1), "most protruding point of the buttock");
  S.wrist_height = fHeight(lv.wrist, af.wrist[0], "wrist (stylion)"); S.olecranon_height = fHeight(lv.olecranon, af.el[0], "point of the elbow (olecranon)");
  S.elbow_height = fHeight(lv.elbow, af.el[0], "elbow (radiale, top of the forearm bone)"); S.dactylion_height = fHeight(lv.dactylion, af.tip[0], "fingertip (dactylion)");
  S.metacarpale_iii_height = fHeight(lv.mc3, af.mc3[0], "knuckle of the middle finger (metacarpale III)");
  S.eye_height = fHeight(lv.eye, CX + 8, "eye"); S.tragion_height = fHeight(lv.tragion, CX - fw.bitragion, "tragion (notch in front of the ear canal)");
  S.midshoulder_height = fHeight(lv.midshoulder, CX - 18, "midpoint of the top of the shoulder");

  // breadths (front / back)
  const brd = (key, y, half, what, pose = "stand") => { S[key] = breadthF(y, half, what, pose); };
  brd("bideltoid_breadth", yBid, hBid, "Greatest width across the shoulder muscles (deltoids)"); brd("biacromial_breadth", L.acromionY, L.acromionX - CX, "Width between the two shoulder points (acromia)");
  brd("chest_breadth", L.chestY, hw(L.chestY), "Width of the chest at nipple level"); brd("hip_breadth", L.hipY, outer(L.hipY), "Greatest width of the hips");
  brd("waist_breadth", L.waistY, hw(L.waistY), "Width of the waist"); brd("bicristal_breadth", lv.iliocristale, hw(lv.iliocristale), "Width between the two hip crests (iliocristale)");
  brd("bispinous_breadth", lv.iliospinale, hw(lv.iliospinale) * .9, "Width between the two front hip spines"); brd("bitrochanteric_breadth", lv.trochanter, outer(lv.trochanter), "Width across the hip joints (trochanters)");
  brd("interscye", lv.scye + 3, hw(lv.scye + 3) * .93, "Width across the back between the rear armpit creases (scye points)", "back");
  brd("back_width", lv.scye - 4, hw(lv.scye - 4) * .9, "Width across the back at shoulder-blade level", "back");
  brd("bustpoint_breadth", lv.bust, wS(["other:bustpoint_bustpoint_breadth", "other:bustpoint_thelion_bustpoint_thelion_breadth"], .1) / 2 || 24, "Distance between the two bust points / nipples");
  brd("neck_breadth", lv.neck, hw(lv.neck), "Width of the neck");
  S.head_breadth = fHB(L.eyeY - 9, headHalf, "Greatest width of the head above the ears"); S.bizygomatic_breadth = fHB(L.eyeY + 3, fw.bizyg, "Width across the cheekbones (zygomatic arches)");
  S.interpupillary_breadth = fHB(L.eyeY, 8, "Distance between the centres of the pupils"); S.biocular_breadth = fHB(L.eyeY, fw.biocular, "Distance between the outer corners of the eyes (ectocanthi)");
  S.interocular_breadth = fHB(L.eyeY, fw.interocular, "Distance between the inner corners of the eyes"); S.bigonial_breadth = fHB(fy("gonion"), fw.bigonial, "Width of the lower jaw between the jaw angles (gonia)");
  S.bitragion_breadth = fHB(fy("tragion"), fw.bitragion, "Width of the head between the tragi (in front of the ear canals)");
  S.nasal_breadth = fHB(fy("alare"), fw.nasal, "Width of the nose across the nostril wings (alare)"); S.nasal_root_breadth = fHB(L.eyeY, fw.nroot, "Width of the nasal root between the eyes");
  S.lip_length = fHB(fy("stomion"), fw.lip, "Width of the mouth between the lip corners (cheilion)"); S.lip_length_smiling = fHB(fy("stomion"), fw.lip * 1.3, "Width of the mouth between the lip corners when smiling");
  S.minimum_frontal_breadth = fHB(fy("frontotemporale"), fw.minfr, "Narrowest width of the forehead (between the frontotemporale points)"); S.maximum_frontal_breadth = fHB(fy("frontotemporale") - 4, fw.maxfr, "Greatest width of the forehead");
  S.ear_protrusion = P("stand", "How far the ear sticks out from the side of the head", hdim(fy("tragion") - 3, CX + headHalf - .4, CX + earOut, [], [[CX + headHalf - .4, fy("tragion") - 3], [CX + earOut, fy("tragion") - 3]]));
  S.span = P("stand", "Fingertip to fingertip with the arms stretched out sideways", hdim(L.acromionY + 8, -40, 240, [], [[-40, L.acromionY + 8], [240, L.acromionY + 8]]));
  S.span_akimbo = P("stand", "Distance across both elbows with the hands on the hips", hdim(af.el[1], 200 - af.el[0] - 8, af.el[0] + 8, [], [[200 - af.el[0] - 8, af.el[1]], [af.el[0] + 8, af.el[1]]]));
  // arms and hands (front view)
  const aw = armHalf(af.el[1], 11);
  S.elbow_breadth = P("stand", "Width of the elbow between the two bony knuckles (humeral epicondyles)", hdim(af.el[1], af.el[0] - aw, af.el[0] + aw, [], [[af.el[0] - aw, af.el[1]], [af.el[0] + aw, af.el[1]]]));
  S.wrist_breadth = P("stand", "Width of the wrist between the two bony knobs (styloid processes)", hdim(af.wrist[1], af.wrist[0] - armHalf(af.wrist[1], 7), af.wrist[0] + armHalf(af.wrist[1], 7), [], [[af.wrist[0] - armHalf(af.wrist[1], 7), af.wrist[1]], [af.wrist[0] + armHalf(af.wrist[1], 7), af.wrist[1]]]));
  const hhalf = .044 * u, hy = af.along(.5)[1], hx = af.along(.5)[0];
  S.hand_breadth = P("stand", "Width of the hand across the knuckles", hdim(hy, hx - hhalf, hx + hhalf, [], [[hx - hhalf, hy], [hx + hhalf, hy]]));
  S.hand_breadth_at_thumb = P("stand", "Width of the hand across the base of the thumb", hdim(af.along(.4)[1], af.along(.4)[0] - hhalf * 1.15, af.along(.4)[0] + hhalf * 1.15, [], [[af.along(.4)[0] - hhalf * 1.15, af.along(.4)[1]], [af.along(.4)[0] + hhalf * 1.15, af.along(.4)[1]]]));
  S.hand_length = P("stand", "From the wrist crease to the tip of the middle finger", vdim(af.tip[0] + 16, af.wrist[1], af.tip[1], [[af.tip[0] + 16, af.wrist[1], af.wrist[0] + 4, af.wrist[1]], [af.tip[0] + 16, af.tip[1], af.tip[0] + 3, af.tip[1]]], [[af.wrist[0] + 4, af.wrist[1]], [af.tip[0] + 3, af.tip[1]]]));
  S.palm_length = P("stand", "From the wrist crease to the base of the middle finger", vdim(af.tip[0] + 16, af.wrist[1], af.mc3[1], [[af.tip[0] + 16, af.wrist[1], af.wrist[0] + 4, af.wrist[1]], [af.tip[0] + 16, af.mc3[1], af.mc3[0] + 8, af.mc3[1]]], [[af.wrist[0] + 4, af.wrist[1]], [af.mc3[0] + 8, af.mc3[1]]]));
  S.index_finger_breadth_distal = P("stand", "Width of the index finger at its end joint", hdim(af.along(.84)[1], af.along(.84)[0] - 3, af.along(.84)[0] + 3, [], [[af.along(.84)[0] - 3, af.along(.84)[1]], [af.along(.84)[0] + 3, af.along(.84)[1]]]));
  S.index_finger_breadth_proximal = P("stand", "Width of the index finger at its base joint", hdim(af.along(.62)[1], af.along(.62)[0] - 3.4, af.along(.62)[0] + 3.4, [], [[af.along(.62)[0] - 3.4, af.along(.62)[1]], [af.along(.62)[0] + 3.4, af.along(.62)[1]]]));
  S.thumb_breadth = P("stand", "Width of the thumb at its end joint", hdim(af.along(.5)[1], af.along(.5)[0] - hhalf - 5, af.along(.5)[0] - hhalf + 1, [], [[af.along(.5)[0] - hhalf - 5, af.along(.5)[1]], [af.along(.5)[0] - hhalf + 1, af.along(.5)[1]]]));
  S.finger_diameter_iii = P("stand", "Thickness of the middle finger at the knuckle", hdim(af.mc3[1], af.mc3[0] - 3.4, af.mc3[0] + 3.4, [], [[af.mc3[0] - 3.4, af.mc3[1]], [af.mc3[0] + 3.4, af.mc3[1]]]));
  S.first_phalanx_length = P("stand", "Length of the first bone of the middle finger", odim(af.along(.6), af.along(.78)));
  S.thumb_crotch_length = P("stand", "From the thumb web to the tip of the middle finger", odim(af.along(.35), af.tip));
  S.hand_circumference = P("stand", "Around the palm at the knuckles, thumb excluded", circ(af.along(.55)[0], af.along(.55)[1], hhalf * .9, hhalf * .2));
  S.hand_circumference_thumb = P("stand", "Around the palm at the knuckles including the thumb base", circ(af.along(.5)[0], af.along(.5)[1], hhalf * 1.1, hhalf * .22));
  S.fist_circumference = P("stand", "Around the clenched fist at the knuckles", circ(af.along(.55)[0], af.along(.55)[1], hhalf * 1.05, hhalf * .24));
  S.grip_diameter_inside = P("stand", "Diameter of the circle formed by the curled fingers and thumb", circ(af.grip[0], af.grip[1], 6, 6));
  S.grip_diameter_outside = P("stand", "Outside diameter of a grip: the circle of the whole hand wrapped round a tube", circ(af.grip[0], af.grip[1], 7.6, 7.6));
  S.hand_thickness = P("sit", "Thickness of the hand at the knuckle of the middle finger", vdim(aq.mc3[0], aq.mc3[1] - 5, aq.mc3[1] + 5, [], [[aq.mc3[0], aq.mc3[1] - 5], [aq.mc3[0], aq.mc3[1] + 5]]));
  // segments
  S.shoulder_length = P("stand", "From the neck base to the tip of the shoulder (acromion)", odim([CX + hw(lv.cervicale - 6) - 4, lv.cervicale - 6], [L.acromionX, L.acromionY]));
  S.acromion_radiale_length = P("stand", "From the tip of the shoulder (acromion) to the top of the forearm bone at the elbow (radiale)", odim(af.sh, af.el));
  S.radiale_stylion_length = P("stand", "From the elbow (radiale) to the wrist (stylion), the length of the forearm", odim(af.el, af.wrist));
  S.elbow_wrist_length = P("stand", "From the elbow to the wrist", odim(af.el, af.wrist));
  S.acromion_dactylion_length = P("stand", "From the tip of the shoulder to the tip of the middle finger", trace([af.sh, af.el, af.wrist, af.tip]));
  S.arm_length = S.acromion_dactylion_length;
  S.sleeve_outseam = P("stand", "Along the outside of the arm from the shoulder point to the wrist", trace([[L.acromionX, L.acromionY], [af.el[0] + 4, af.el[1]], [af.wrist[0] + 3, af.wrist[1]]]));
  S.sleeve_inseam = P("stand", "Along the inside of the arm from the armpit to the wrist", trace([[af.sh[0] - 6, lv.axilla + 2], [af.el[0] - 6, af.el[1]], [af.wrist[0] - 4, af.wrist[1]]]));
  // legs (front)
  const [kc, kr] = legC(lv.knee), [ac, arr] = legC(L.ankleY);
  S.femoral_breadth = P("stand", "Width of the knee between the two bony knuckles of the thigh bone (femoral epicondyles)", hdim(lv.knee, kc - kr, kc + kr, [], [[kc - kr, lv.knee], [kc + kr, lv.knee]]));
  S.knee_knee_breadth = P("stand", "Distance across both knees", hdim(lv.knee, 200 - kc - kr, kc + kr, [], [[200 - kc - kr, lv.knee], [kc + kr, lv.knee]]));
  const [tcx, tcr] = legC(Y(.42));
  S.thigh_thigh_breadth = P("stand", "Distance across both thighs at their widest", hdim(Y(.42), 200 - tcx - tcr, tcx + tcr, [], [[200 - tcx - tcr, Y(.42)], [tcx + tcr, Y(.42)]]));
  const [bc, br] = legC(lv.malleolusL);
  S.bimalleolar_breadth = P("stand", "Width of the ankle between the two ankle bones (malleoli)", hdim(lv.malleolusL, bc - br, bc + br, [], [[bc - br, lv.malleolusL], [bc + br, lv.malleolusL]]));
  S.foot_breadth = P("stand", "Greatest width of the foot across the ball", hdim(444, leg(440)[0], leg(440)[1], [], [[leg(440)[0], 444], [leg(440)[1], 444]]));
  S.heel_breadth = P("back", "Width of the heel", hdim(446, 200 - leg(440)[1] + 4, 200 - leg(440)[0] - 4, [], [[200 - leg(440)[1] + 4, 446], [200 - leg(440)[0] - 4, 446]]));
  // circumferences
  S.chest_circumference = ring(L.chestY, hw(L.chestY), hw(L.chestY) * .2, "stand", "Around the chest at nipple level, under the arms");
  S.waist_circumference = ring(L.waistY, hw(L.waistY), hw(L.waistY) * .2, "stand", "Around the waist at its narrowest");
  S.waist_circumference_navel = ring(lv.navel, hw(lv.navel), hw(lv.navel) * .2, "stand", "Around the waist at navel level");
  S.buttock_circumference = ring(L.buttY, outer(L.buttY), outer(L.buttY) * .2, "stand", "Around the buttocks at their fullest");
  S.hip_circumference = ring(L.hipY, outer(L.hipY), outer(L.hipY) * .2, "stand", "Around the hips at their fullest");
  S.hip_circumference_trochanter = ring(lv.trochanter, outer(lv.trochanter), outer(lv.trochanter) * .2, "stand", "Around the hips at the level of the trochanters");
  S.chest_circumference_scye = ring(lv.scye + 3, hw(lv.scye + 3), hw(lv.scye + 3) * .2, "stand", "Around the chest and back at armpit (scye) level");
  S.chest_circumference_below_bust = ring(lv.bust + 12, hw(lv.bust + 12), hw(lv.bust + 12) * .2, "stand", "Around the chest just below the bust");
  S.neck_circumference = ring(lv.neck, hw(lv.neck), hw(lv.neck) * .2, "stand", "Around the neck just below the Adam's apple");
  S.neck_circumference_base = ring(lv.cervicale + 2, hw(lv.cervicale + 2) * .75, hw(lv.cervicale + 2) * .2, "stand", "Around the base of the neck over the cervicale");
  S.shoulder_circumference = P("stand", "Around the shoulders over the deltoids", circ(CX, yBid + 8, hBid, 10));
  S.head_circumference = P("stand", "Around the head above the brow ridges", circ(CX, L.eyeY - 9, headHalf, 4));
  S.thigh_circumference = legRing(276, "Around the thigh just below the crotch"); S.lower_thigh_circumference = legRing(305, "Around the thigh just above the knee");
  S.mid_thigh_circumference = legRing(Y(.40), "Around the thigh half-way between hip and knee"); S.crotch_thigh_circumference = legRing(lv.crotch + 4, "Around the thigh just below the crotch");
  S.knee_circumference = legRing(L.kneeY, "Around the knee"); S.calf_circumference = legRing(366, "Around the calf at its fullest");
  S.ankle_circumference = legRing(L.ankleY, "Around the ankle at its narrowest"); S.heel_ankle_circumference = legRing(438, "Around the heel and the top of the foot (heel-ankle)");
  S.wrist_circumference = armRing(af.wrist[1] + 3, 8, "Around the wrist"); S.biceps_circumference = armRing(af.ua(.45)[1], 13, "Around the upper arm at its fullest");
  S.axillary_arm_circumference = armRing(lv.axilla + 6, 15, "Around the upper arm just below the armpit"); S.forearm_circumference = armRing(af.fa(.2)[1], 11, "Around the forearm at its fullest");
  S.elbow_circumference = armRing(af.el[1], 12, "Around the elbow"); S.arm_scye_circumference = P("stand", "Around the shoulder through the armpit (arm scye)", circ(CX + hw(122) + 4, 116, 8, 22, true));
  S.scye_circumference = S.arm_scye_circumference;
  S.vertical_trunk_circumference = P("stand", "Round the trunk from the crotch up over the shoulder and back down", circ(CX, (L.neckY + L.crotchY) / 2, hw(L.waistY) * .7, (L.crotchY - L.neckY) / 2, true));
  S.ball_of_foot_circumference = P("sit", "Around the foot at the ball", circ(G.footToeBall, G.floorY - 7, 7, 7, true));
  S.instep_circumference = P("sit", "Around the foot over the instep", circ(G.heel + (G.toe - G.heel) * .5, G.floorY - 11, 7, 11, true));
  S.abdominal_circumference = P("stand", "Around the abdomen at its fullest", circ(CX, lv.navel + 4, hw(lv.navel) * 1.02, hw(lv.navel) * .2));

  // ---- seated (side view) ----------------------------------------------------------------------------------------------------------------------------
  S.sitting_height = seatTo(40, G.headTop[1], G.headTop[0], "Vertical distance from the seat to the top of the head");
  S.eye_height_sitting = seatTo(40, G.eye[1], G.eye[0] + 4, "Vertical distance from the seat to the outer corner of the eye");
  S.acromion_height_sitting = seatTo(40, G.acromion[1], G.acromion[0], "Vertical distance from the seat to the tip of the shoulder");
  S.elbow_rest_height = seatTo(52, G.olecranonY, ex, "Vertical distance from the seat to the bottom of the elbow, forearm horizontal");
  S.thigh_clearance = P("sit", "Thickness of the thigh from the seat to the top of the thigh at the hip", vdim(G.thighTop[0], G.thighTop[1], SEAT, [], [[G.thighTop[0], G.thighTop[1]]]));
  S.knee_height_sitting = P("sit", "Vertical distance from the floor to the top of the knee", vdim(G.kneeFront[0] + 16, G.kneeTop[1], G.floorY, [[G.kneeFront[0] + 16, G.kneeTop[1], G.kneeTop[0], G.kneeTop[1]]], [[G.kneeTop[0], G.kneeTop[1]]]));
  S.popliteal_height = P("sit", "Vertical distance from the floor to the underside of the thigh behind the knee", vdim(pop[0] - 16, pop[1], G.floorY, [[pop[0] - 16, pop[1], pop[0], pop[1]]], [pop]));
  S.buttock_knee_length = P("sit", "Horizontal distance from the rearmost point of the buttocks to the front of the knee", hdim(yf, 76, G.kneeFront[0], [[76, yBut, 76, yf], [G.kneeFront[0], G.kneeFront[1], G.kneeFront[0], yf]], [[76, yBut], G.kneeFront]));
  S.buttock_popliteal_length = P("sit", "Horizontal distance from the rearmost point of the buttocks to the back of the knee", hdim(yf, 76, pop[0], [[76, yBut, 76, yf], [pop[0], pop[1], pop[0], yf]], [[76, yBut], pop]));
  S.chest_depth = depthQ(L.chestY + dz, "Front-to-back depth of the chest at nipple level");
  S.buttock_depth = depthQ(yBut, "Front-to-back depth from the buttocks to the belly");
  S.shoulder_elbow_length = P("sit", "From the tip of the shoulder to the bottom of the elbow", vdim(56, G.acromion[1], ey, [[56, G.acromion[1], G.acromion[0], G.acromion[1]], [56, ey, ex, ey]], [G.acromion, G.elbow]));
  S.forearm_hand_length = P("sit", "From the back of the elbow to the tip of the middle finger", hdim(yFore, ex, fgx, [[ex, ey, ex, yFore], [fgx, fgy, fgx, yFore]], [G.elbow, G.finger]));
  S.foot_length = P("sit", "From the back of the heel to the tip of the longest toe", hdim(yf, G.heel, G.toe, [[G.heel, G.floorY, G.heel, yf], [G.toe, G.floorY, G.toe, yf]], [[G.heel, G.floorY], [G.toe, G.floorY]]));
  // head (side)
  S.head_length = P("sit", "From the glabella (between the brows) to the back of the head", hdim(G.browZ, H.opisthocranion[0], H.glabella[0], [], [[H.opisthocranion[0], G.browZ], [H.glabella[0], G.browZ]]));
  S.menton_sellion_length = hV("sellion", "menton", "From the nasal root (sellion) to the bottom of the chin (menton)");
  S.ear_length = P("sit", "Height of the ear from top to bottom", vdim(H.ear_outer - 6, H.ear_top, H.ear_bottom, [[H.ear_outer - 6, H.ear_top, H.ear_outer + 3, H.ear_top], [H.ear_outer - 6, H.ear_bottom, H.ear_outer + 5, H.ear_bottom]], [[H.ear_outer + 3, H.ear_top], [H.ear_outer + 5, H.ear_bottom]]));
  S.ear_breadth = P("sit", "Width of the ear from its front edge to its back rim", hdim(H.ear_top - 5, H.ear_outer, H.ear_front, [[H.ear_outer, H.ear_top + 1, H.ear_outer, H.ear_top - 5], [H.ear_front, H.ear_top + 4, H.ear_front, H.ear_top - 5]], [[H.ear_outer, H.ear_top + 1], [H.ear_front, H.ear_top + 4]]));
  S.ear_length_above_tragion = hV("earTop", "tragion", "From the top of the ear to the tragion", "sit", -42);
  S.ectocanthus_otobasion = P("sit", "From the outer corner of the eye to where the ear joins the head", odim(hp.ectocanthus, hp.tragion));
  S.menton_subnasale_length = hV("subnasale", "menton", "From the base of the nose (subnasale) to the bottom of the chin");
  S.subnasale_sellion_length = hV("sellion", "subnasale", "From the nasal root (sellion) to the base of the nose");
  S.menton_crinion_length = hV("crinion", "menton", "From the hairline (crinion) to the bottom of the chin");
  S.philtrum_length = hV("subnasale", "labrale_sup", "From the base of the nose to the upper lip");
  S.lip_to_lip_length = hV("labrale_sup", "labrale_inf", "Height of the lips from the upper edge to the lower edge");
  S.nose_length = hV("sellion", "pronasale", "From the nasal root (sellion) to the tip of the nose");
  S.nose_protrusion = hHor("subnasale", "pronasale", "How far the nose sticks out: from the base of the nose to the tip", 0);
  S.chin_length = hV("labrale_inf", "menton", "From the lower lip to the bottom of the chin");
  S.menton_projection = P("sit", "How far the chin sticks out in front of the lips", hdim(hpy("pogonion"), hpx("labrale_inf"), hpx("pogonion"), [], [[hpx("labrale_inf"), hpy("pogonion")], [hpx("pogonion"), hpy("pogonion")]]));
  // sleeves, back and front lengths
  S.waist_back_length = P("back", "Down the back from the cervicale to the waist", trace([[CX, lv.cervicale], [CX, L.waistY]]));
  S.waist_front_length = P("stand", "Down the front from the neck base to the waist", trace([[CX, lv.suprasternale], [CX, lv.navel]]));
  S.spine_to_scye = P("back", "From the spine across the back to the scye (armpit) point", hdim(lv.scye + 3, CX, CX + hw(lv.scye + 3) * .93, [], [[CX, lv.scye + 3], [CX + hw(lv.scye + 3) * .93, lv.scye + 3]]));
  S.spine_to_elbow = P("back", "Along the back from the spine over the shoulder to the elbow", trace([[CX, lv.cervicale], [200 - L.acromionX, L.acromionY], [200 - af.el[0] - 3, af.el[1]]]));
  S.spine_to_wrist = P("back", "Along the back from the spine over the shoulder and elbow to the wrist", trace([[CX, lv.cervicale], [200 - L.acromionX, L.acromionY], [200 - af.el[0] - 3, af.el[1]], [200 - af.wrist[0] - 3, af.wrist[1]]]));
  S.waist_hip_length = P("stand", "Down the side from the waist to the hip", vdim(CX + outer(L.waistY) + 10, L.waistY, L.hipY, [[CX + outer(L.waistY) + 10, L.waistY, CX + hw(L.waistY), L.waistY], [CX + outer(L.waistY) + 10, L.hipY, CX + outer(L.hipY), L.hipY]], [[CX + hw(L.waistY), L.waistY], [CX + outer(L.hipY), L.hipY]]));
  S.waist_back = S.waist_back_length;
  const trunkLoop = (pose, a, b, c, desc) => P(pose, desc, trace(loopPath(pose, a, b, c)));
  S.crotch_length = trunkLoop("side", lv.navel, lv.navel, lv.crotch, "From the navel down through the crotch and up to the same level at the back");
  S.crotch_length_front = P("side", "From the navel down the front to the crotch", trace(surf("side", true, lv.navel, lv.crotch)));
  S.crotch_length_rear = P("side", "From the crotch up the back to the waist", trace(surf("side", false, lv.crotch, lv.navel)));
  S.bust_depth = depthS(lv.bust, "Front-to-back depth of the body at the bust point");
  S.waist_depth = depthS(L.waistY, "Front-to-back depth of the waist"); S.abdominal_extension_depth = depthS(lv.navel + 6, "Front-to-back depth at the fullest part of the belly");
  S.calf_depth = depthS(lv.calf, "Front-to-back depth of the calf"); S.waist_depth_sitting = depthQ(L.waistY + dz, "Front-to-back depth of the waist, seated");
  S.chest_depth_scye = depthS(lv.scye + 3, "Front-to-back depth of the chest at armpit level");

  // reach (standing, back to a wall)
  const wallR = (y) => wallm(76, y - 18, y + 18);
  const reachTo = (pt, desc) => P("reach", desc, wallR(pt[1]), hdim(pt[1] + 10, 76, pt[0], [[76, pt[1] + 10, 76, pt[1] + 10], [pt[0], pt[1], pt[0], pt[1] + 10]], [[pt[0], pt[1]]]));
  S.thumbtip_reach = reachTo(ar.thumb, "Horizontal distance from a wall behind the shoulder blades to the tip of the thumb, arm stretched forward");
  S.grip_reach = reachTo(ar.grip, "Horizontal distance from a wall behind the shoulder blades to the centre of the grip, arm stretched forward");
  S.arm_reach = reachTo(ar.tip, "Horizontal distance from a wall behind the shoulder blades to the tip of the middle finger, arm stretched forward");
  S.index_finger_reach = reachTo(ar.tip, "Horizontal distance from a wall behind the shoulder blades to the tip of the index finger, arm stretched forward");
  S.maximum_reach = reachTo([ar.tip[0] + 8, ar.tip[1]], "Horizontal distance from a wall to the fingertip at the furthest reach, shoulders pulled forward");
  S.wrist_wall_length = reachTo(ar.wrist, "Horizontal distance from a wall behind the shoulder blades to the wrist, arm stretched forward");
  S.shoulder_grip_length = P("reach", "From the tip of the shoulder to the centre of the grip, arm stretched forward", odim(ar.sh, ar.grip));
  S.acromion_wall_depth = P("sit", "Horizontal distance from the wall behind the back to the tip of the shoulder", wallm(W.sit_back, G.acromion[1] - 18, G.acromion[1] + 18), hdim(G.acromion[1], W.sit_back, G.acromion[0], [], [[G.acromion[0], G.acromion[1]]]));
  // overhead reach
  const upTo = (pt, desc, pose = "up") => P(pose, desc, vdim(pose === "up" ? 20 : 36, pt[1], pose === "up" ? 450 : SEAT, [[pose === "up" ? 20 : 36, pt[1], pt[0], pt[1]]], [[pt[0], pt[1]]]));
  S.vertical_reach = upTo(au.tip, "Vertical distance from the floor to the fingertip with the arm stretched overhead");
  S.vertical_grip_reach = upTo(au.grip, "Vertical distance from the floor to the centre of the grip with the arm stretched overhead");
  S.vertical_reach_sitting = upTo(aqu.tip, "Vertical distance from the seat to the fingertip with the arm stretched overhead", "situp");
  S.vertical_grip_reach_sitting = upTo(aqu.grip, "Vertical distance from the seat to the centre of the grip with the arm stretched overhead", "situp");
  // legs extended (seated, back to a wall)
  const LF = D.legfoot;
  S.buttock_heel_length = P("sitleg", "Horizontal distance from the wall behind the buttocks to the heel, leg stretched forward", wallm(76, LF.heel[1] - 22, LF.heel[1] + 22), hdim(LF.heel[1] + 12, 76, LF.heel[0], [[LF.heel[0], LF.heel[1], LF.heel[0], LF.heel[1] + 12]], [[LF.heel[0], LF.heel[1]]]));
  S.functional_leg_length = P("sitleg", "Horizontal distance from the wall behind the buttocks to the ball of the foot, leg stretched forward", wallm(76, LF.ball[1] - 22, LF.ball[1] + 22), hdim(LF.ball[1] - 4, 76, LF.ball[0], [], [[LF.ball[0], LF.ball[1]]]));

  // ---- skinfolds ----------------------------------------------------------------------------------------------------
  const sk = (pose, x, y, desc) => P(pose, desc, site(x, y));
  S.triceps_skinfold = sk("back", 200 - af.ua(.55)[0], af.ua(.55)[1], "Fold of skin and fat pinched at the back of the upper arm, half-way between shoulder and elbow");
  S.subscapular_skinfold = sk("back", CX + hw(lv.scye + 18) * .45, lv.scye + 16, "Fold pinched just below the tip of the shoulder blade");
  S.suprailiac_skinfold = sk("stand", CX - hw(lv.iliocristale) + 6, lv.iliocristale - 4, "Fold pinched just above the hip crest in the line of the armpit");
  S.abdominal_skinfold = sk("stand", CX + 10, lv.navel + 2, "Fold pinched beside the navel");
  S.biceps_skinfold = sk("stand", af.ua(.5)[0] - 3, af.ua(.5)[1], "Fold pinched over the front of the upper arm");
  S.chest_skinfold = sk("stand", CX + hw(lv.axilla) * .55, lv.axilla + 6, "Fold pinched between the armpit and the nipple");
  S.midaxillary_skinfold = sk("stand", CX + hw(lv.substernale) * .9, lv.substernale, "Fold pinched at the side of the chest at breastbone level");
  S.juxta_nipple_skinfold = sk("stand", CX + (wS(["other:bustpoint_bustpoint_breadth"], .1) / 2 || 24) + 5, lv.bust + 2, "Fold pinched beside the nipple");
  S.supraspinale_skinfold = sk("stand", CX + hw(lv.iliocristale) * .6, lv.iliocristale + 3, "Fold pinched above the front hip spine");
  S.thigh_skinfold = sk("stand", legC(Y(.38))[0], Y(.38), "Fold pinched over the front of the thigh, half-way between hip and knee");
  S.calf_skinfold = sk("stand", legC(lv.calf)[0] - legC(lv.calf)[1] + 2, lv.calf, "Fold pinched on the inner side of the calf at its fullest");
  S.suprapatella_skinfold = sk("stand", legC(lv.patella - 8)[0], lv.patella - 8, "Fold pinched just above the kneecap");
  S.dorsal_hand_skinfold = sk("stand", af.mc3[0], af.mc3[1], "Fold pinched on the back of the hand");
  S.back_skinfold = S.subscapular_skinfold;


  // seated levels from the survey means (fraction of sitting height)
  const sy = (keys, d) => yQ(keys, d);
  const sFront = y => sitSide(y, 0), sRear = y => sitSide(y, 1);
  const cervSit = sy(["other:cervicale_height_sitting"], .62), supraSit = cervSit + 16;
  S.cervicale_height_sitting = seatTo(40, cervSit, sRear(cervSit), "Vertical distance from the seat to the cervicale (bump at the base of the neck)");
  S.midshoulder_height_sitting = seatTo(40, sy(["other:midshoulder_height_sitting", "other:mid_shoulder_height_sitting"], .6), G.shoulder[0] + 8, "Vertical distance from the seat to the midpoint of the top of the shoulder");
  S.chest_height_sitting = seatTo(40, sy(["other:chest_height_sitting"], .45), sFront(sy(["other:chest_height_sitting"], .45)), "Vertical distance from the seat to the nipple (bust point)");
  S.waist_height_sitting = seatTo(40, sy(["other:waist_height_sitting", "other:waist_height_sitting_omphalion"], .3), sFront(sy(["other:waist_height_sitting", "other:waist_height_sitting_omphalion"], .3)), "Vertical distance from the seat to the waist");
  S.wrist_height_sitting = seatTo(40, sy(["other:wrist_height_sitting"], .22), aq.wrist[0], "Vertical distance from the seat to the wrist, forearm horizontal");
  S.knee_height_midpatella = P("sit", "Vertical distance from the floor to the middle of the kneecap", vdim(G.kneeFront[0] + 16, G.kneeJoint[1] - 2, G.floorY, [[G.kneeFront[0] + 16, G.kneeJoint[1] - 2, G.kneeFront[0] - 2, G.kneeJoint[1] - 2]], [[G.kneeFront[0] - 2, G.kneeJoint[1] - 2]]));
  S.waist_front_length_sitting = P("sit", "Down the front from the suprasternale to the waist, seated", trace(surf("sit", true, supraSit, sy(["other:waist_height_sitting", "other:waist_height_sitting_omphalion"], .3))));
  S.waist_circumference_sitting = P("sit", "Around the waist, seated", circ((sFront(L.waistY + dz) + sRear(L.waistY + dz)) / 2, L.waistY + dz, 3.5, (sFront(L.waistY + dz) - sRear(L.waistY + dz)) / 2, true));
  S.posterior_neck_length = P("sit", "Along the back of the neck from the nuchale (base of the skull) to the cervicale", vdim(Math.min(sRear(cervSit), hp.nuchale[0]) - 14, hp.nuchale[1], cervSit, [[Math.min(sRear(cervSit), hp.nuchale[0]) - 14, hp.nuchale[1], hp.nuchale[0], hp.nuchale[1]], [Math.min(sRear(cervSit), hp.nuchale[0]) - 14, cervSit, sRear(cervSit), cervSit]], [[hp.nuchale[0], hp.nuchale[1]], [sRear(cervSit), cervSit]]));
  S.anterior_neck_length = P("sit", "Down the front of the neck from the chin (menton) to the suprasternale", vdim(sFront(supraSit) + 18, hp.menton[1], supraSit, [[sFront(supraSit) + 18, hp.menton[1], hp.menton[0], hp.menton[1]], [sFront(supraSit) + 18, supraSit, sFront(supraSit), supraSit]], [hp.menton, [sFront(supraSit), supraSit]]));
  // foot (seated side view)
  const fl = G.toe - G.heel, ballX = G.footToeBall;
  S.ball_of_foot_length = P("sit", "From the back of the heel to the ball of the foot (first toe joint)", hdim(yf, G.heel, ballX, [[G.heel, G.floorY, G.heel, yf], [ballX, G.floorY - 4, ballX, yf]], [[G.heel, G.floorY], [ballX, G.floorY - 4]]));
  S.instep_length = P("sit", "From the back of the heel to the front of the ankle (the instep)", hdim(yf, G.heel, G.heel + fl * .66, [[G.heel, G.floorY, G.heel, yf], [G.heel + fl * .66, G.floorY - 12, G.heel + fl * .66, yf]], [[G.heel, G.floorY], [G.heel + fl * .66, G.floorY - 12]]));
  S.medial_malleolus_hallux_length = P("sit", "From the inner ankle bone to the tip of the big toe", odim([G.heel + fl * .2, G.floorY - 20], [G.toe, G.floorY - 4]));
  S.outside_leg_length = P("stand", "Down the outside of the leg from the waist to the floor", vdim(CX + outer(L.waistY) + 14, L.waistY, 450, [[CX + outer(L.waistY) + 14, L.waistY, CX + hw(L.waistY), L.waistY]], [[CX + hw(L.waistY), L.waistY]]));
  S.leg_length = fHeight(lv.trochanter, CX - outer(lv.trochanter), "hip joint (trochanter), the length of the leg");
  S.thigh_length = P("stand", "From the hip joint (trochanter) down to the knee", vdim(CX + outer(lv.trochanter) + 12, lv.trochanter, lv.knee, [[CX + outer(lv.trochanter) + 12, lv.trochanter, CX + outer(lv.trochanter), lv.trochanter], [CX + outer(lv.trochanter) + 12, lv.knee, 200 - kc - kr, lv.knee]], [[CX + outer(lv.trochanter), lv.trochanter], [200 - kc - kr, lv.knee]]));
  S.waist_natural_navel_length = P("stand", "Down the front between the narrowest waist and the navel", vdim(CX + 12, L.waistY, lv.navel, [], [[CX + 12, L.waistY], [CX + 12, lv.navel]]));
  S.abdominal_extension_height = sHeight(lv.navel + 6, side(lv.navel + 6, 0), "most protruding point of the belly");
  S.biinfraorbitale_breadth = fHB(fy("infraorbitale"), 11, "Distance between the lower edges of the eye sockets (infraorbitale)");
  S.head_height = hV("tragion", "vertex", "From the tragion (in front of the ear canal) to the top of the head");
  S.menton_vertex_height = hV("menton", "vertex", "From the bottom of the chin to the top of the head");
  S.head_diagonal_menton_occiput = P("sit", "Slanting length from the chin (menton) to the back of the head", odim(hp.menton, hp.opisthocranion));
  S.head_diagonal_nuchale = P("sit", "Slanting length from the chin (menton) to the nuchale (nape of the skull)", odim(hp.menton, hp.nuchale));
  S.head_diagonal_inion_pronasale = P("sit", "Slanting length from the inion (bump at the back of the skull) to the tip of the nose", odim(hp.inion, hp.pronasale));
  S.waist_hip_ratio = P("stand", "Waist circumference divided by hip circumference", circ(CX, L.waistY, hw(L.waistY), hw(L.waistY) * .2), circ(CX, L.hipY, outer(L.hipY), outer(L.hipY) * .2));
  S.waist_to_height_ratio = P("stand", "Waist circumference divided by stature", vdim(14, 10, 450, [], []), circ(CX, L.waistY, hw(L.waistY), hw(L.waistY) * .2));
  S.interscye_curvature = P("back", "Curve across the back between the two scye (armpit) points", archq([CX - hw(lv.scye + 3) * .93, lv.scye + 3], [CX + hw(lv.scye + 3) * .93, lv.scye + 3], lv.scye - 3));
  S.back_curvature = P("side", "Curve of the back along the spine from the cervicale to the waist", trace(surf("side", false, lv.cervicale, L.waistY)));
  S.coat_length = P("back", "Down the back from the cervicale to the hem of a coat", trace([[CX, lv.cervicale], [CX, Y(.40)]]));
  S.spine_length = P("back", "Along the spine from the cervicale to the sacrum", trace([[CX, lv.cervicale], [CX, lv.iliocristale + 14]]));
  S.trunk_height = P("sit", "From the seat to the cervicale (trunk height)", vdim(40, cervSit, SEAT, [[40, cervSit, sRear(cervSit), cervSit]], [[sRear(cervSit), cervSit]]));
  S.handgrip_strength = P("stand", "Squeezing force of the hand, measured with a hand dynamometer", circ(af.grip[0], af.grip[1], 7, 7));
  S.deltoid_arc = P("back", "Over the shoulders from one deltoid to the other across the back", archq([CX - hBid, yBid + 8], [CX + hBid, yBid + 8], yBid - 2));
  S.chest_excursion = P("stand", "Difference in chest circumference between full breath in and full breath out", circ(CX, L.chestY, hw(L.chestY), hw(L.chestY) * .2));

  // extra segments
  S.wrist_center_grip = P("stand", "From the wrist crease to the centre of a gripped cylinder", odim(af.wrist, af.grip));
  S.wrist_thumbtip = P("stand", "From the wrist crease to the tip of the thumb", odim(af.wrist, af.thumb));
  S.elbow_grip = P("sit", "From the back of the elbow to the centre of a gripped cylinder, forearm horizontal", odim(aq.el, aq.grip));
  S.acromion_to_biceps = P("stand", "Down the upper arm from the tip of the shoulder to the level of the biceps measurement", odim(af.sh, af.ua(.45)));
  S.axilla_to_waist = P("stand", "Down the side of the body from the armpit to the waist", vdim(CX + outer(L.waistY) + 12, lv.axilla, L.waistY, [[CX + outer(L.waistY) + 12, lv.axilla, CX + hw(lv.axilla), lv.axilla], [CX + outer(L.waistY) + 12, L.waistY, CX + hw(L.waistY), L.waistY]], [[CX + hw(lv.axilla), lv.axilla], [CX + hw(L.waistY), L.waistY]]));
  const bustHalf = wS(["other:bustpoint_bustpoint_breadth", "other:bustpoint_thelion_bustpoint_thelion_breadth"], .1) / 2 || 24;
  const neckSide = [CX + hw(lv.neck + 8) + 1, lv.neck + 4];
  S.neck_bust = P("stand", "From the side of the neck base over the shoulder slope to the bust point", trace([neckSide, [CX + bustHalf, lv.bust]]));
  S.nape_bust = P("stand", "From the back of the neck over the shoulder to the bust point", trace([[CX, lv.cervicale], neckSide, [CX + bustHalf, lv.bust]]));
  S.nape_waist_over_bust = P("stand", "From the back of the neck over the shoulder and bust to the waist", trace([[CX, lv.cervicale], neckSide, [CX + bustHalf, lv.bust], [CX, lv.navel]]));
  S.neck_waist = P("stand", "From the side of the neck base over the bust to the waist", trace([neckSide, [CX + bustHalf, lv.bust], [CX, lv.navel]]));
  S.forearm_forearm_breadth = P("stand", "Distance across both forearms at their widest", hdim(af.fa(.3)[1], 200 - af.fa(.3)[0] - 12, af.fa(.3)[0] + 12, [], [[200 - af.fa(.3)[0] - 12, af.fa(.3)[1]], [af.fa(.3)[0] + 12, af.fa(.3)[1]]]));
  return { S, lv, hp, fw, headHalf, sex };
}

// ---- key -> definition ----------------------------------------------------------------------------------------------------------------------------------------------
const ALIAS = {
  // measures that are the same landmark pair under another name
  shoulder_height: "acromion_height", elbow_radiale_height: "elbow_height", elbow_rest_height_standing: "elbow_height", stylion_wrist_height: "wrist_height", penale_height: "crotch_height",
  kneecap_height: "patella_height", patella_top_height: "patella_height", patella_bottom_height: "patella_height", tibial_height: "tibiale_height", tibiale_laterale_height: "tibiale_height",
  knee_level: "knee_height", lateral_femoral_epicondyle_height: "femoral_epicondyle_height", fibular_height: "tibiale_height", chest_height: "bust_height", breast_height: "bust_height", nipple_height: "bust_height",
  nipple_chest_height: "bust_height", bustpoint_height: "bust_height", waist_height_omphalion: "navel_height", waist_height_preferred: "waist_height", waist_height_natural_indentation: "waist_height",
  stature_maximum: "stature", stature_as_reported: "stature", head_height_tragion_to_vertex: "tragion_to_top_of_head", menton_vertex_height: "menton_to_top_of_head",
  shoulder_breadth: "biacromial_breadth", shoulder_width: "biacromial_breadth", interscye_breadth: "interscye", interscye_maximum: "interscye", back_breadth: "back_width", chest_breadth_bone: "chest_breadth",
  bustpoint_bustpoint_breadth: "bustpoint_breadth", bustpoint_thelion_bustpoint_thelion_breadth: "bustpoint_breadth", hip_breadth_standing: "hip_breadth", bi_iliocristale_breadth: "bicristal_breadth",
  bi_trochanteric_breadth: "bitrochanteric_breadth", elbow_breadth_humeral_breadth: "elbow_breadth", humerus_breadth: "elbow_breadth", humerus_biepicondylar_breadth: "elbow_breadth", femoral_breadth_knee_breadth: "femoral_breadth",
  femur_breadth: "femoral_breadth", femur_biepicondylar_breadth: "femoral_breadth", knee_to_knee_breadth: "knee_knee_breadth", knee_knee_breadth_sitting: "knee_knee_breadth", thigh_thigh_breadth_sitting: "thigh_thigh_breadth",
  elbow_elbow_breadth: "span_akimbo", elbow_to_elbow_breadth: "span_akimbo",
  bitragion_diameter: "bitragion_breadth", biauricular_breadth: "bitragion_breadth", ear_to_ear_breadth: "bitragion_breadth", bigonial_diameter: "bigonial_breadth", biocular_diameter: "biocular_breadth",
  interocular_diameter: "interocular_breadth", maximum_frontal_diameter: "maximum_frontal_breadth", minimum_frontal_diameter: "minimum_frontal_breadth", nose_breadth: "nasal_breadth", lip_width: "lip_length",
  lip_to_lip_distance: "lip_to_lip_length", headboard_lip_length: "lip_length", face_breadth: "bizygomatic_breadth", face_length: "menton_sellion_length", face_menton_sellion_length: "menton_sellion_length",
  nasal_root_height: "nasal_root_breadth", ear_length_above_tragion: "ear_length_above_tragion", ectocanthus_to_otobasion: "ectocanthus_otobasion",
  hand_breadth_across_thumb: "hand_breadth_at_thumb", hand_circumference_including_thumb: "hand_circumference_thumb", hand_circumference_at_thumb: "hand_circumference_thumb", hand_depth: "hand_thickness",
  hand_thickness_thickness_at_metacarpale_iii: "hand_thickness", thickness_at_metacarpal_iii: "hand_thickness", finger_diameter_at_metacarpale_iii: "finger_diameter_iii", first_phalanx_length_digit_iii: "first_phalanx_length",
  wrist_index_finger_length: "hand_length", wrist_center_of_grip_length: "wrist_center_grip", wrist_centre_grip_distance: "wrist_center_grip", wrist_centre_thumbtip_distance: "wrist_thumbtip", wrist_tiumebtip_length: "wrist_thumbtip",
  forearm_haind_length: "forearm_hand_length", forearm_fingertip_length: "forearm_hand_length", elbow_grip_length: "elbow_grip", forearm_center_of_grip_length: "elbow_grip",
  acromion_to_dactylion_length: "acromion_dactylion_length", shoulder_wrist_length: "acromion_dactylion_length", sleeve_length: "spine_to_wrist", sleeve_length_spine_wrist: "spine_to_wrist", sleeve_length_segment_spine_to_wrist_length: "spine_to_wrist",
  spine_to_wrist_sleeve_length: "spine_to_wrist", sleeve_length_posterior: "spine_to_wrist", sleeve_length_spine_elbow: "spine_to_elbow", sleeve_length_segment_spine_to_elbow_length: "spine_to_elbow",
  sleeve_length_segment_spine_to_scye_length: "spine_to_scye", sleeve_length_spine_scye: "spine_to_scye", acromion_to_biceps_circumference_level_length: "acromion_to_biceps",
  neck_bustpoint_thelion_length: "neck_bust", neck_bustpoint_length: "neck_bust", nape_to_bustpoint_thelion_length: "nape_bust", nape_bustpoint_thelion_length: "nape_bust",
  nape_to_waist_over_bust: "nape_waist_over_bust", nape_waist_over_bust: "nape_waist_over_bust", neck_bustpoint: "neck_bust",
  waist_back: "waist_back_length", back_waist_length: "waist_back_length", back_length: "waist_back_length", nape_to_waist_centre_back: "waist_back_length", nape_waist_centre_back: "waist_back_length",
  waist_back_length_omphalion: "waist_back_length", waist_back_length_natural_indentation: "waist_back_length", waist_level_centre_back: "waist_back_length", torso_length: "waist_back_length",
  waist_front: "waist_front_length", waist_front_length_omphalion: "waist_front_length", waist_front_length_natural_indentation: "waist_front_length", anterior_waist_length: "waist_front_length", front_length: "waist_front_length",
  waist_level_centre_front: "waist_front_length", neck_waist_length: "neck_waist", axilla_to_waist_length: "axilla_to_waist",
  waist_hip_distance: "waist_hip_length", crotch_length_omphalion: "crotch_length", crotch_length_natural_indentation: "crotch_length", crotch_length_posterior_omphalion: "crotch_length_rear",
  crotch_length_posterior_natural_indentation: "crotch_length_rear", crotch_waist_preferred_anterior: "crotch_length_front", crotch_waist_preferred_posterior: "crotch_length_rear",
  waist_circumference_non_omphalion: "waist_circumference", waist_circumference_preferred: "waist_circumference", waist_circumference_natural_indentation: "waist_circumference", waist_girth: "waist_circumference",
  waist_circumference_over_foundation_garment: "waist_circumference", waist_circumference_sitting: "waist_circumference_sitting", abdominal_or_waist_circumference: "waist_circumference_navel", waist_omphalion_breadth: "waist_breadth",
  waist_breadth_over_foundation_garment: "waist_breadth", waist_depth_standing: "waist_depth", waist_depth_over_foundation_garment: "waist_depth", waist_omphalion_depth: "waist_depth",
  hip_girth_maximum: "hip_circumference", maximum_hip_circumference: "hip_circumference", hip: "hip_circumference", high_hip: "hip_circumference", hip_breadth_over_foundation_garment: "hip_breadth", hip_breadth_sitting: "hip_breadth",
  hip_circumference_at_trochanterion: "hip_circumference_trochanter", halfway_to_hip_circumference: "hip_circumference", hip_circumference_7in_below_waist_level: "hip_circumference", hip_circumference_9in_below_waist_level: "hip_circumference",
  hip_circumference_7in_below_waist_level_over_foundation_garment: "hip_circumference", hip_circumference_9in_below_waist_level_over_foundation_garment: "hip_circumference",
  chest_circumference_at_scye: "chest_circumference_scye", chest_circumference_below_breast: "chest_circumference_below_bust", chest_circumference_inspiration: "chest_circumference", chest_circumference_expiration: "chest_circumference",
  chest_depth_at_scye: "chest_depth_scye", scye_depth: "chest_depth_scye", bust_level: "bust_height", chest_level: "bust_height", hip_level_female: "trochanterion_height", hip_level_male: "trochanterion_height",
  neck_height_lateral: "cervicale_height", shoulder_height_sitting: "acromion_height_sitting", mid_shoulder_height_sitting: "midshoulder_height_sitting", sitting_height_relaxed: "sitting_height", eye_height_sitting_relaxed: "eye_height_sitting",
  waist_height_sitting_natural_indentation: "waist_height_sitting", waist_height_sitting_omphalion: "waist_height_sitting", abdominal_extension_height_over_foundation_garment: "abdominal_extension_height",
  medial_malleolus_hallax_length: "medial_malleolus_hallux_length", foot_ball_length: "ball_of_foot_length", leg_length_iaf: "leg_length", thigh_length_iaf: "thigh_length",
  interscye_curvature_maximum: "interscye_curvature", waist_natural_indentation_waist_omphalion_length: "waist_natural_navel_length", biocular_breadth_maximum: "biocular_breadth", biinfraorbitale_breadth: "biinfraorbitale_breadth",
  head_diagonal_menton_to_back_of_head: "head_diagonal_menton_occiput", spine_to_elbow_length: "spine_to_elbow", spine_to_scye_length: "spine_to_scye", waist_to_height_ratio: "waist_to_height_ratio", ankle_girth: "ankle_circumference", elbow_girth: "elbow_circumference", elbow_circumference_flexed: "elbow_circumference", elbow_circumference_relaxed: "elbow_circumference",
  elbow_circumference_fully_bent: "elbow_circumference", knee_circumference_fully_bent: "knee_circumference", knee_circumference_sitting: "knee_circumference", thigh_girth: "thigh_circumference",
  thigh_circumference_sitting: "thigh_circumference", mid_thigh_circumference: "mid_thigh_circumference", midthigh_circumference: "mid_thigh_circumference", calf_circumference_ii: "calf_circumference",
  upper_arm_circumference: "biceps_circumference", upper_arm_circumference_relaxed: "biceps_circumference", arm_circumference_relaxed: "biceps_circumference", biceps_circumference_relaxed: "biceps_circumference",
  biceps_circumference_flexed: "biceps_circumference", forearm_circumference_flexed: "forearm_circumference", forearm_circumference_relaxed: "forearm_circumference", forearm_circumference_maximum: "forearm_circumference",
  arm_scye_circumference: "arm_scye_circumference", foot_ball_circumference: "ball_of_foot_circumference", ball_foot_circumference: "ball_of_foot_circumference", buttock_circumference_sitting: "buttock_circumference",
  buttock_circumference_sitting_over_foundation_garment: "buttock_circumference", vertical_trunk_circumference_sitting: "vertical_trunk_circumference", vertical_trunk_circumference_wide: "vertical_trunk_circumference",
  vertical_trunk_circumference_ascc: "vertical_trunk_circumference", abdominal_extension_depth_over_foundation_garment: "abdominal_extension_depth", abdominal_depth_sitting: "waist_depth_sitting", abdominal_extension_circumference: "abdominal_circumference",
  abdominal_extension_circumference_over_foundation_garment: "abdominal_circumference", buttock_depth_over_foundation_garment: "buttock_depth",
  arm_reach_from_wall: "arm_reach", arm_reach_forward: "arm_reach", arm_reach_fingertip: "arm_reach", functional_reach: "arm_reach", thumb_tip_reach_extended: "thumbtip_reach", maximum_reach_from_wall: "maximum_reach",
  wrist_wall_length_extended: "wrist_wall_length", arm_reach_upward: "vertical_reach", overhead_fingertip_reach: "vertical_reach", overhead_fingertip_reach_extended: "vertical_reach", vertical_reach_sitting: "vertical_reach_sitting",
  overhead_fingertip_reach_sitting: "vertical_reach_sitting", vertical_grip_reach: "vertical_grip_reach", functional_leg_length_horizontal: "functional_leg_length",
  handgrip_strength_left: "handgrip_strength", handgrip_strength_right: "handgrip_strength",
  triceps_skinfold: "triceps_skinfold", skinfold_triceps: "triceps_skinfold", back_of_arm_skinfold: "triceps_skinfold", skinfold_upper_arm: "triceps_skinfold", subscapular_skinfold: "subscapular_skinfold", skinfold_subscapular: "subscapular_skinfold",
  sub_scapular_skinfold: "subscapular_skinfold", suprailiac_skinfold: "suprailiac_skinfold", skinfold_suprailiac: "suprailiac_skinfold", skinfold_iliac_crest: "suprailiac_skinfold", abdominal_skinfold: "abdominal_skinfold",
  skinfold_abdominal: "abdominal_skinfold", skinfold_abdomen: "abdominal_skinfold", skinfold_biceps: "biceps_skinfold", skinfold_chest: "chest_skinfold", skinfold_midaxillary: "midaxillary_skinfold", mid_axillary_skinfold: "midaxillary_skinfold",
  midaxillary_line_at_xiphoid_level_skinfold: "midaxillary_skinfold", mid_axillary_line_at_umbilicus_skinfold: "midaxillary_skinfold", skinfold_thigh: "thigh_skinfold", skinfold_front_thigh: "thigh_skinfold", skinfold_calf: "calf_skinfold",
  skinfold_medial_calf: "calf_skinfold", medial_calf_skinfold: "calf_skinfold", suprapatella_skinfold: "suprapatella_skinfold", skinfold_supraspinale: "supraspinale_skinfold", skinfold_back: "back_skinfold",
  juxta_nipple_skinfold: "juxta_nipple_skinfold", dorsal_hand_skinfold: "dorsal_hand_skinfold",
  chin_prominence_to_wall: "pogonion_to_wall", external_canthus_to_wall: "ectocanthus_to_wall", nasal_root_to_wall: "sellion_to_wall", lip_protrusion_to_wall: "labrale_sup_to_wall",
  head_diagonal_maximum_from_menton_to_occiput: "head_diagonal_menton_occiput", head_diagonal_maximum_from_nuchale: "head_diagonal_nuchale",
  head_diagonal_from_inion_to_pronasale: "head_diagonal_inion_pronasale", headboard_nose_protrusion: "nose_protrusion", chin_back_of_head: "pogonion_to_wall",
  minimum_frontal_arc: "bitragion_minimum_frontal_arc", minimum_frontal_curvature: "bitragion_minimum_frontal_arc", sagittal_arc: "sagittal_arc", sagittal_curvature: "sagittal_arc",
  bitragion_coronal_curvature: "bitragion_coronal_arc", bitragion_menton_curvature: "bitragion_menton_arc", bitragion_minimum_frontal_curvature: "bitragion_minimum_frontal_arc",
  bitragion_posterior_curvature: "bitragion_posterior_arc", bitragion_submandibular_curvature: "bitragion_submandibular_arc", bitragion_subnasale_curvature: "bitragion_subnasale_arc",
  bitragion_inion_arc: "bitragion_posterior_arc", gluteal_arc: "buttock_circumference",
};
const WALL_NAMES = { sellion: "sellion", glabella: "glabella", ectocanthus: "ectocanthus", pronasale: "pronasale", subnasale: "subnasale", menton: "menton", tragion: "tragion", labrale_sup: "labrale_sup", pogonion: "pogonion",
  alare: "alare", cheilion: "cheilion", chin: "pogonion", crinion: "crinion", ectoorbitale: "ectoorbitale", frontotemporale: "frontotemporale", gonion: "gonion", infraorbitale: "infraorbitale", stomion: "stomion",
  zygion: "zygion", zygofrontale: "zygofrontale", infraorb1tale: "infraorbitale", larynx: "larynx" };
const TOP_NAMES = ["tragion", "ectocanthus", "menton", "stomion", "pronasale", "sellion", "subnasale", "glabella", "alare", "cheilion", "crinion", "ectoorbitale", "frontotemporale", "gonion", "infraorbitale", "zygion", "zygofrontale", "infraorb1tale"];
const ARC_APEX = { coronal: n => n.hp.vertex[1] - n.dz, submandibular: n => n.hp.menton[1] - n.dz + 5, subnasale: n => n.hp.subnasale[1] - n.dz, minimum_frontal: n => n.hp.glabella[1] - n.dz - 11,
  menton: n => n.hp.menton[1] - n.dz, chin: n => n.hp.pogonion[1] - n.dz, crinion: n => n.hp.crinion[1] - n.dz, frontal: n => n.hp.glabella[1] - n.dz - 8, mandibular: n => n.hp.menton[1] - n.dz - 2, posterior: n => n.hp.inion[1] - n.dz };

function normalise(key) {
  let k = key.replace(/^other:/, "").replace(/^headboard_/, "");
  k = k.replace(/_(ii|i)$/, "").replace(/_over_foundation_garment$/, "");
  return k;
}

export function resolve(key, sex = "M") {
  const sx = sex === "F" ? "F" : "M", N = marksFor(sx), { S, hp } = N, D = DATA[sx];
  const raw = key.replace(/^other:/, "");
  let k = normalise(key);
  if (/(^|_)(mass|weight|bmi|fat|skeletal_muscle)(_|$)/.test(raw)) return { ...TINT("A whole-body measure."), kind: "exact" };
  if (/^visceral_adipose/.test(k)) return { pose: "stand", desc: "Fat deep in the abdomen (scanned cross-section at the waist).", m: [region(CX, D.L.waistY + 4, hwOf(D, D.L.waistY) * 1.05, 14)], kind: "exact" };
  for (let i = 0; i < 4 && ALIAS[k] && ALIAS[k] !== k && !S[k]; i++) k = ALIAS[k];
  if (S[k]) return { ...S[k], kind: "exact" };
  // head: landmark to the wall behind the head / back of head
  let m = /^(.+?)_(?:to_wall|back_of_head)$/.exec(k);
  if (m) { const lm = WALL_NAMES[m[1]]; if (lm === "larynx") return larynxWall(N, D); if (lm && hp[lm]) return { ...headWallMark(N, lm), kind: "exact" }; }
  // head: landmark to the top of the head
  m = /^(.+?)_(?:to_)?top_of_head$/.exec(k);
  if (m && TOP_NAMES.includes(m[1])) return { ...headTop(N, m[1].replace("infraorb1tale", "infraorbitale")), kind: "exact" };
  if (k === "menton_to_top_of_head") return { ...headTop(N, "menton"), kind: "exact" };
  // bitragion arcs
  m = /^bitragion_(coronal|submandibular|subnasale|minimum_frontal|menton|posterior|chin|crinion|frontal|mandibular)_(?:arc|curvature)$/.exec(k);
  if (m) return { ...arcMark(N, D, m[1]), kind: "exact" };
  if (k === "sagittal_arc") return { ...sagittal(N, D), kind: "exact" };
  // scrotale (crotch) to level trunk lengths
  const sc = scrotale(k, N, D); if (sc) return { ...sc, kind: "exact" };
  return regionFor(k, D);
}

const hwOf = (D, y) => { const o = D.tw, yy = Math.round(y / 2) * 2; for (let d = 0; d <= 40; d += 2) { const v = o[yy + d] || o[yy - d]; if (v) return v; } return 40; };

function headWallMark(N, lm) {
  const { hp } = N, x = hp.opisthocranion[0], y = hp[lm][1];
  return { pose: "sit", desc: `Horizontal distance from a wall touching the back of the head to the ${lm.replace(/_/g, " ").replace("sup", "superius")}.`, m: [wallm(x, y - 16, y + 16), hdim(y, x, hp[lm][0], [], [[hp[lm][0], y]])] };
}
function larynxWall(N, D) {
  const { hp } = N, x = hp.opisthocranion[0], y = hp.menton[1] + 13, fx = (near(D.td, y - (D.G.eye[1] - D.L.eyeY)) || [118])[0];
  return { pose: "sit", desc: "Horizontal distance from a wall touching the back of the head to the larynx (Adam's apple).", m: [wallm(x, y - 16, y + 16), hdim(y, x, fx, [], [[fx, y]])], kind: "exact" };
}
function headTop(N, lm) {
  const { hp } = N, ya = hp.vertex[1], yb = hp[lm][1], x = hp.pronasale[0] + 14;
  return { pose: "sit", desc: `Vertical distance from the ${lm.replace(/_/g, " ")} to the top of the head.`, m: [vdim(x, ya, yb, [[x, ya, hp.vertex[0] + 8, ya], [x, yb, hp[lm][0], yb]], [[hp[lm][0], yb]])] };
}
function arcMark(N, D, which) {
  const { hp, fw } = N, dz = D.G.eye[1] - D.L.eyeY, ty = hp.tragion[1] - dz;
  const apexFn = ARC_APEX[which], apex = apexFn({ hp, dz });
  const tr = fw.bitragion;
  if (which === "posterior" || which === "inion") return { pose: "back", desc: "Over the back of the head from one tragion (ear) to the other, passing the inion.", m: [archq([CX - tr, ty], [CX + tr, ty], apex)] };
  const what = { coronal: "over the top of the head", submandibular: "under the jaw", subnasale: "across the base of the nose", minimum_frontal: "across the forehead at its narrowest", menton: "across the chin", chin: "across the chin tip", crinion: "along the hairline", frontal: "across the forehead", mandibular: "along the jaw" }[which] || "";
  return { pose: "stand", desc: `From one tragion (ear) to the other ${what}.`, m: [archq([CX - tr, ty], [CX + tr, ty], apex)] };
}
function sagittal(N, D) {
  const { hp } = N; const H = D.head.outline;
  const near1 = p => H.reduce((best, q, i) => (dist(p, q) < best[0] ? [dist(p, q), i] : best), [1e9, 0])[1];
  const i = near1(hp.sellion), j = near1(hp.inion); const pts = [...H.slice(0, i + 1).reverse(), ...H.slice(j).reverse()];
  return { pose: "sit", desc: "Over the top of the head from the nasal root (sellion) to the inion (bump at the back of the skull).", m: [trace(pts)] };
}
function scrotale(k, N, D) {
  const m = /^scrotale_(.*)$/.exec(k); if (!m) return null;
  const sitting = /_sitting$/.test(k), pose = sitting ? "sit" : "side", dz = D.G.eye[1] - D.L.eyeY;
  const { lv } = N, up = (y) => sitting ? y + dz : y;
  const fn = sitting ? (y, f) => (near(D.td, y - dz) || [130, 70])[f ? 0 : 1] : (y, f) => (near(D.ts, y) || [135, 80])[f ? 0 : 1];
  const yc = up(lv.crotch) + (sitting ? -6 : 0);
  const lvl = /midshoulder/.test(k) ? up(lv.midshoulder) : /scye/.test(k) ? up(lv.scye) : /waist/.test(k) ? up(D.L.waistY) : /suprasternale/.test(k) ? up(lv.suprasternale) : /cervicale/.test(k) ? up(lv.cervicale) : up(lv.scye);
  const front = /anterior|suprasternale/.test(k), over = /over_buttock/.test(k);
  const path = (frontSide, a, b) => { const pts = [], step = b > a ? 4 : -4; for (let y = a; step > 0 ? y < b : y > b; y += step) pts.push([fn(y, frontSide), y]); pts.push([fn(b, frontSide), b]); return pts; };
  let pts;
  if (/over_buttock/.test(k)) pts = [...path(true, yc, lvl), [fn(lvl, 1), lvl], ...path(false, lvl, yc)];
  else if (front) pts = path(true, yc, lvl);
  else pts = path(false, yc, lvl);
  const lvName = /midshoulder/.test(k) ? "the top of the shoulder" : /scye/.test(k) ? "armpit (scye) level" : /waist/.test(k) ? "the waist" : /suprasternale/.test(k) ? "the suprasternale" : "the cervicale";
  return { pose, desc: over ? `From the crotch up the front to ${lvName}, over to the back, and down the back to the crotch.` : front ? `From the crotch up the front of the body to ${lvName}.` : `From the crotch up the back of the body to ${lvName}.`, m: [trace(pts)] };
}

function regionFor(k, D) {
  const L = D.L, G = D.G, CXs = CX, u = L.u;
  const R = [
    [/foot|heel|instep|toe|ball_of/, "sit", { cx: (G.heel + G.toe) / 2, cy: G.floorY - 6, rx: (G.toe - G.heel) / 2 + 8, ry: 16 }],
    [/head|ear|face|zygom|sellion|menton|tragion|nose|nasal|mouth|chin|eye|interpupil|orbit|cranial|brow|lip|crinion|glabella|stomion|gonion|canthus/, "stand", { cx: CXs, cy: 42, rx: 30, ry: 38 }],
    [/hand|palm|thumb|finger|knuckle|grip/, "stand", { cx: (L.wristX + L.fingerX) / 2, cy: (L.wristY + L.fingerY) / 2, rx: 16, ry: 30 }],
    [/thigh|knee|calf|leg|inseam|crotch|ankle|tibi|popliteal|patella|malleol/, "stand", { cx: CXs + 30, cy: (L.crotchY + 440) / 2, rx: 30, ry: (440 - L.crotchY) / 2 + 6 }],
    [/sleeve|arm|elbow|biceps|forearm|axilla|wrist/, "stand", { cx: (L.shoulderX + L.wristX) / 2, cy: (Y(.815) + L.wristY) / 2, rx: 26, ry: (L.wristY - Y(.815)) / 2 + 8 }],
    [/waist|chest|hip|buttock|trunk|torso|rise|back|bust|shoulder|scye|stern|rib|abdom|gluteal|nape|neck/, "stand", { cx: CXs, cy: 150, rx: 60, ry: 90 }],
  ];
  const hit = R.find(([re]) => re.test(k));
  return hit ? { pose: hit[1], desc: "", m: [{ k: "r", ...hit[2] }], kind: "region" } : { pose: "stand", desc: "", m: [], kind: "none" };
}
