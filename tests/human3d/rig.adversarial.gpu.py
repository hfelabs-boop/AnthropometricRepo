"""GPU resource accounting through renderer.info in a real WebGL context: create/render/dispose 20 rigs, draw calls per display config.
   python3 tests/human3d/rig.adversarial.gpu.py"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
JS = """
async () => {
  const A = window.A, out = {};
  const info = () => ({ geo: A.renderer.info.memory.geometries, tex: A.renderer.info.memory.textures, prog: A.renderer.info.programs.length });
  const draw = (name) => { A.renderer.info.reset(); A.sheet([{}], {cols: 1}); const r = A.renderer.info.render; out[name] = { calls: r.calls, tris: r.triangles }; };
  A.sheet([{}], {cols: 1});
  out.base = info();
  // draw calls in each configuration
  for (const [name, d] of Object.entries({
    default: { skeleton: true, joints: true, axes: true, landmarks: false, labels: false, com: false },
    all: { skeleton: true, joints: true, axes: true, landmarks: true, labels: true, com: true, skin: true },
    none: { skeleton: false, joints: false, axes: false, landmarks: false, labels: false, com: false },
    jointsOnly: { skeleton: false, joints: true },
  })) { A.rig.setDisplay(d); draw(name); }
  A.rig.select("shoulder_L"); draw("selected");
  A.rig.select(null);
  // lifecycle
  const before = info();
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const r = A.rebuild({});
    r.setDisplay({ skeleton: true, joints: true, landmarks: true, com: true, labels: true });
    r.select(i % 2 ? "elbow_L" : "head"); r.highlight("hip_R");
    r.setPose({ root: { y: 1, heading: i * 17 }, angles: { hip_L: [40, 0, 0] } });
    A.sheet([{}], {cols: 1});
    samples.push(info());
  }
  A.scene.remove(A.rig.group); A.rig.dispose();
  A.renderer.info.reset(); A.renderer.render(A.scene, A.camera);
  out.before = before; out.after = info(); out.samples = [samples[0], samples[9], samples[19]];
  return out;
}
"""
with browser(1000, 650) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html")
    page.wait_for_function("window.__ready", timeout=60000)
    print(json.dumps(page.evaluate(JS), indent=1))
    print("\n".join(logs))
