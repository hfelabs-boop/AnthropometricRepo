"""The rig inside the real site: 15 profile switches (stature / sex), GPU resources and scene size must stay constant; console must stay clean.
   python3 tests/human3d/rig.adversarial.site2.py"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
with browser(1280, 800) as (page, logs):
    page.add_init_script("try{localStorage.setItem('hm-debug','1')}catch(e){}")
    page.goto(page.base + "/#/human")
    page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=120000)
    page.wait_for_timeout(1000)
    res = page.evaluate("""async ()=>{
      const H = window.__human, ctx = H.ctx, r = H.viewport.renderer;
      const count = (o) => { let n = 0; o.traverse(() => n++); return n; };
      const snap = () => ({ geo: r.info.memory.geometries, tex: r.info.memory.textures, nodes: count(H.viewport.scene), prog: r.info.programs.length });
      const mk = (i) => ({ id: "t" + i, label: "test " + i, sex: i % 2 ? "F" : "M", source: { kind: "manual" }, measures: { stature: { value: 1500 + 40 * i, unit: "mm", status: "reported" }, mass: { value: 50 + 3 * i, unit: "kg", status: "reported" } }, notes: [] });
      const wait = () => new Promise((res) => { const off = ctx.on("rig", () => { off(); setTimeout(res, 50); }); });
      const out = [snap()];
      for (let i = 0; i < 15; i++) { const p = wait(); ctx.setProfile(mk(i)); await Promise.race([p, new Promise(r => setTimeout(r, 8000))]); H.viewport.requestRender(); await new Promise(r => setTimeout(r, 120)); out.push(snap()); }
      return { out, rigH: (() => { const rg = ctx.getRig(); return rg.jointWorld("head").y; })() };
    }""")
    for s in res["out"]: print(s)
    print("head y of last", res["rigH"])
    print("\n".join(l for l in logs if "404" not in l))
