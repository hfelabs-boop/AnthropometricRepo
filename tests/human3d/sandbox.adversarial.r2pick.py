"""Round 2: cost of one hover pick over an object while the skinned figure is visible (skinDistance runs a skinned ray test), and over empty floor."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    r = page.evaluate(f"""async () => {{
      const sb = await {SB}, vp = window.__human.viewport, V = vp.camera.position.constructor;
      const o = sb.add('crate', {{ position: [0, 0, -0.6], params: {{ width: 1.2, height: 1.5, depth: 0.4 }} }});
      vp.requestRender(); await new Promise(r => setTimeout(r, 300));
      const c = new V(0, 1.2, 0.0), s = vp.project(c), rc = vp.canvas.getBoundingClientRect();
      const x = rc.left + s.x, y = rc.top + s.y;
      const t = (fn, n = 20) => {{ const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return (performance.now() - t0) / n; }};
      const hit = sb.pickAt(x, y);
      const withObj = t(() => sb.pickAt(x, y));
      const empty = t(() => sb.pickAt(rc.left + 5, rc.top + 5));
      const withSkin = (window.__human.ctx.getRig().skin ? true : false);
      return {{ hit: hit && hit.obj.id, withObj, empty, withSkin, tris: window.__human.ctx.getRig().skin?.geometry.index?.count / 3 }};
    }}""")
    print(r)
