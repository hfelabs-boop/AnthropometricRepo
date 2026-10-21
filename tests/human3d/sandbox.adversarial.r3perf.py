"""Round 3: 100 objects with names shown + 60 measurements: time of a viewport frame (labels included), of a pose change and of an object move."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    r = page.evaluate(f"""async () => {{
      const sb = await {SB}, ms = await {MS}, vp = window.__human.viewport, ctx = window.__human.ctx;
      const types = ['crate','small_box','stool','desk','monitor','pallet','drum','ladder','box','cylinder'];
      for (let i = 0; i < 100; i++) sb.add(types[i % types.length], {{ position: [-4 + (i % 10) * 0.9, 0, -4 + Math.floor(i / 10) * 0.9], silent: true }});
      sb.setShowNames(true);
      const ids = [...sb.objects.keys()];
      for (let i = 0; i < 60; i++) ms.addDistance({{ kind: 'landmark', id: 'eye_mid' }}, {{ kind: 'object', id: ids[i], anchor: Object.keys(sb.objects.get(ids[i])._anchors)[0] }});
      const t = (fn, n = 10) => {{ const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return +((performance.now() - t0) / n).toFixed(2); }};
      const out = {{ objects: sb.objects.size, measures: ms.items.length }};
      vp.requestRender(); await new Promise(r => setTimeout(r, 1500));
      out.frame_ms = t(() => {{ vp.camera.position.x += 0.001; vp.controls.update?.(); vp.renderNow ? vp.renderNow() : vp.requestRender(); }});
      out.move_ms = t(() => sb.move(ids[3], [Math.random(), 0, 1]));
      out.pose_ms = t(() => ctx.getRig().setAngles({{ shoulder_L: [Math.random() * 40, 0, 0] }}));
      ms.flush?.(); out.msflush_ms = t(() => ms.flush?.());
      return out;
    }}""")
    print(json.dumps(r))
    page.wait_for_timeout(500)
    page.screenshot(path=str(lib.OUT / "r3-perf-100.png"))
    print("labels in DOM:", page.evaluate("document.querySelectorAll('.hm-label, .hm-overlay > *').length"))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
