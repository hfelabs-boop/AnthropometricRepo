"""The rig inside the real site (#/human): screenshots with display flags and a selected joint, 4 configs (light/dark x desktop/phone).
   python3 tests/human3d/rig.adversarial.site.py <outdir>"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import shot
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for dark in (False, True):
    for (w, h, mob) in ((1280, 800, False), (390, 800, True)):
        tag = f"{'dark' if dark else 'light'}-{w}"
        with browser(w, h, dark=dark, mobile=mob) as (page, logs):
            page.add_init_script("try{localStorage.setItem('hm-debug','1')}catch(e){}")
            page.goto(page.base + "/#/human")
            page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=120000)
            page.wait_for_timeout(1500)
            page.screenshot(path=str(out / f"site-{tag}-1.png"))
            page.evaluate("()=>{const r=window.__human.ctx.getRig(); r.select('shoulder_L'); r.highlight('knee_R'); r.setDisplay({labels:true, landmarks:true, com:true}); window.__human.viewport.requestRender();}")
            page.wait_for_timeout(800)
            page.screenshot(path=str(out / f"site-{tag}-2.png"))
            print(tag, "\n".join(l for l in logs if "error" in l.lower() or "warn" in l.lower())[:600])
