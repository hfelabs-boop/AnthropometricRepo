"""Contact sheets of the catalogue by category and mode (default / min / max) from the author's sandbox-catalog page. Usage: python3 sandbox.adversarial.sheets2.py OUTDIR [mode ...]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
modes = sys.argv[2:] or ["default"]
cats = ["Seating", "Displays", "Boxes and loads", "Structures", "Tools and controls", "Reference"]
with browser(1000, 800) as (page, logs):
    for mode in modes:
        for c in cats:
            page.goto(f"{page.base}/__pages/sandbox.adversarial.sheet.html?category={c.replace(' ', '%20')}&cols=4&tile=250&mode={mode}")
            page.wait_for_function("window.__ready", timeout=120000)
            page.wait_for_timeout(300)
            page.locator("#wrap").screenshot(path=str(out / f"{mode}-{c.split()[0]}.png"))
    print([l for l in logs if "error" in l.lower()][:5])
