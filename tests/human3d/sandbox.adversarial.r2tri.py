import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
with browser(700, 700) as (page, logs):
    for name, q in [("top-160", 'p={"panelAngle":160}'), ("top-120", 'p={"panelAngle":120}'), ("top-120-curved", 'p={"panelAngle":120,"curved":true}')]:
        page.goto(f"{page.base}/__pages/sandbox.adversarial.sheet.html?type=triple_monitor&size=600&az=0&el=89&{q}")
        page.wait_for_function("window.__ready", timeout=120000)
        page.locator("#wrap").screenshot(path=str(out / f"tri-{name}.png"))
