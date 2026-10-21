"""All joints at their max / min / random corner limits, skeleton view.  python3 tests/human3d/rig.adversarial.limits.py <outdir>"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
with browser(1000, 800) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?w=1000&h=800")
    page.wait_for_function("window.__ready", timeout=60000)
    for name, mode in (("max", "max"), ("min", "min"), ("mix", "mix")):
        page.evaluate("""(mode)=>{ const A=window.A; const ang={}; let i=0; for (const j of A.JOINTS) ang[j.id]=j.dof.map(d=>mode==='max'?d.max:mode==='min'?d.min:((i++%2)?d.max:d.min)); window.__p={angles:ang}; }""", mode)
        views = [dict(az=0, el=5, dist=3.4, target=[0, 0.9, 0]), dict(az=90, el=5, dist=3.4, target=[0, 0.9, 0]), dict(az=180, el=5, dist=3.4, target=[0, 0.9, 0]), dict(az=45, el=25, dist=3.4, target=[0, 0.9, 0])]
        page.evaluate("(v)=>window.A.sheet(v,{poseName:window.__p,cols:2,display:{skeleton:true,joints:false,axes:false}})", views)
        page.wait_for_timeout(120)
        page.locator("#c").screenshot(path=str(out / f"limits-{name}.png"))
    print("\n".join(logs))
