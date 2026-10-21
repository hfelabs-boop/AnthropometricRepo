"""Round-4: phone layout of the viewer toolbars. python3 tests/human3d/rig.adversarial.round4c.py <outdir>"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for dark in (False, True):
    with browser(390, 800, dark=dark, mobile=True) as (page, logs):
        page.add_init_script("try{localStorage.setItem('hm-debug','1')}catch(e){}")
        page.goto(page.base + "/#/human")
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=120000)
        page.wait_for_timeout(1500)
        r = page.evaluate("""()=>{
          const out=[]; for (const el of document.querySelectorAll('.hm-root *')) { const cs=getComputedStyle(el); if (el.scrollWidth>el.clientWidth+1 && (cs.overflowX==='auto'||cs.overflowX==='scroll'||cs.overflowX==='hidden'||cs.overflowX==='visible') && el.clientWidth>0) out.push([el.className.toString().slice(0,60), cs.overflowX, el.scrollWidth, el.clientWidth]); }
          return {out, doc:[document.documentElement.scrollWidth, innerWidth]}; }""")
        print("dark" if dark else "light", json.dumps(r))
        page.evaluate("()=>{window.scrollTo(0, document.querySelector('.hm-root').getBoundingClientRect().top + scrollY - 60)}")
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / f"phone-{'dark' if dark else 'light'}-viewer.png"))
        page.evaluate("()=>window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / f"phone-{'dark' if dark else 'light'}-bottom.png"))
        print("\n".join(l for l in logs if "404" not in l))
