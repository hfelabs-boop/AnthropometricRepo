"""Main-thread cost in a real browser: rig build, first skeleton build, pose update, pickBone / pickJoint over a grid of screen positions.
   python3 tests/human3d/rig.adversarial.perf.py"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
JS = """
async () => {
  const A = window.A, T = A.THREE, out = {};
  const t = (f) => { const a = performance.now(); const r = f(); return [performance.now() - a, r]; };
  A.rig.setDisplay({ skeleton: true, joints: true });
  const cam = A.camera; cam.aspect = 1.5; cam.updateProjectionMatrix();
  A.sheet([{}], { cols: 1 });
  const rc = new T.Raycaster(); rc.camera = cam;
  const grid = (n) => { const a = []; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) a.push([(i + .5) / n * 2 - 1, (j + .5) / n * 2 - 1]); return a; };
  for (const fn of ["pickBone", "pickJoint"]) {
    let worst = 0, sum = 0, hits = 0; const pts = grid(20);
    for (const [x, y] of pts) { rc.setFromCamera(new T.Vector2(x, y), cam); const [dt, r] = t(() => A.rig[fn](rc)); worst = Math.max(worst, dt); sum += dt; if (r) hits++; }
    out[fn] = { meanMs: sum / pts.length, worstMs: worst, hits, n: pts.length };
  }
  // fresh build timings
  const times = [];
  for (let i = 0; i < 5; i++) { const [dt] = t(() => { const r = A.rebuild({ skeleton: true }); return r; }); times.push(dt); }
  out.rebuildMs = times;
  const [d2] = t(() => A.rig.setPose({ root: { y: 1 }, angles: { hip_L: [30, 0, 0] } }));
  out.setPoseMs = d2;
  const ts = []; for (let i = 0; i < 200; i++) ts.push(t(() => A.rig.setPose({ root: { y: 0.9, heading: i }, angles: { hip_L: [i % 60, 0, 0], knee_L: [i % 90, 0] } }))[0]);
  out.setPoseMeanMs = ts.reduce((a, b) => a + b) / ts.length;
  const lm = A.rig.setDisplay({ landmarks: true, com: true, labels: true });
  const ts2 = []; for (let i = 0; i < 200; i++) ts2.push(t(() => A.rig.setPose({ root: { y: 0.9, heading: i }, angles: { hip_L: [i % 60, 0, 0] } }))[0]);
  out.setPoseWithOverlaysMeanMs = ts2.reduce((a, b) => a + b) / ts2.length;
  out.labelAnchorsMs = t(() => A.rig.labelAnchors())[0];
  out.lowestYMs = t(() => { for (let i = 0; i < 100; i++) A.rig.lowestY(); })[0] / 100;
  // lazily built bones: skeleton off at build, then on
  const r = A.rebuild({ skeleton: true }); r.setDisplay({ skeleton: false, joints: false });
  out.firstSkeletonToggleMs = t(() => r.setDisplay({ skeleton: true }))[0];
  out.secondToggleMs = t(() => { r.setDisplay({ skeleton: false }); r.setDisplay({ skeleton: true }); })[0];
  return out;
}
"""
with browser(1000, 650) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html")
    page.wait_for_function("window.__ready", timeout=60000)
    print(json.dumps(page.evaluate(JS), indent=1))
    print("\n".join(logs))
