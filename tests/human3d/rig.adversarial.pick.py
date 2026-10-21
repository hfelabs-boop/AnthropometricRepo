"""Real-site picking: click on the projected position of every joint marker (front view, default framing) and see what gets selected.
   python3 tests/human3d/rig.adversarial.pick.py"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
with browser(1280, 800) as (page, logs):
    page.add_init_script("try{localStorage.setItem('hm-debug','1')}catch(e){}")
    page.goto(page.base + "/#/human")
    page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=120000)
    page.wait_for_timeout(1500)
    page.evaluate("()=>window.__human.viewport.setView('front')")
    page.wait_for_timeout(1200)
    info = page.evaluate("""()=>{
      const H = window.__human, rig = H.ctx.getRig(), vp = H.viewport;
      const canvas = vp.renderer.domElement, r = canvas.getBoundingClientRect();
      const out = [];
      for (const [id] of rig.bones) { const p = rig.jointWorld(id); const s = vp.project(p); out.push({ id, x: r.left + s.x, y: r.top + s.y, vis: s.visible }); }
      return { pts: out, rect: [r.left, r.top, r.width, r.height] };
    }""")
    print("canvas", info["rect"])
    res = {"ok": 0, "other": [], "none": []}
    for p in info["pts"]:
        page.mouse.click(p["x"], p["y"])
        page.wait_for_timeout(30)
        sel = page.evaluate("()=>window.__human.state.selection?.id ?? null")
        if sel == p["id"]: res["ok"] += 1
        elif sel is None: res["none"].append(p["id"])
        else: res["other"].append(f"{p['id']}->{sel}")
        page.evaluate("()=>window.__human.ctx.select(null)")
    print("exact", res["ok"], "of", len(info["pts"]))
    print("none:", len(res["none"]), res["none"][:60])
    print("other:", len(res["other"]), res["other"][:80])
    print("\n".join(l for l in logs if "error" in l.lower())[:500])
