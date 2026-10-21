import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2
with browser(1000, 800, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?w=1000&h=800")
    page.wait_for_function("window.__ready", timeout=60000)
    views = [dict(az=0, el=0, dist=0.75, target=[0, 1.3, 0.1]), dict(az=60, el=10, dist=0.75, target=[0, 1.3, 0.1])]
    page.evaluate("(a)=>window.A.sheet(a,{poseName:'neutral',cols:2,display:{skeleton:true,joints:false,axes:false}})", views)
    page.locator("#c").screenshot(path=str(out / "chest.png"))
    print("\n".join(logs))
