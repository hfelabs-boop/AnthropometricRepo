"""Helpers for the adversarial browser scripts of the sandbox (sandbox.adversarial.*.py). Not a test: import it from a sibling script."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from shot import browser  # noqa: E402

OUT = Path("/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad/sbxadv")
OUT.mkdir(parents=True, exist_ok=True)
SB = "(async () => (await import('/js/human/sandbox.js')).peekSandbox(window.__human.viewport))()"
MS = "(async () => (await import('/js/human/measure.js')).peekMeasure(window.__human.viewport))()"


def open_human(page, tab="scene", settle=800):
    page.goto(f"{page.base}/#/human?debug")
    page.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer", timeout=180000)
    page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=180000)
    page.wait_for_timeout(settle)
    page.click(f"#hm-tab-{tab}")
    page.wait_for_selector(".hm-sc" if tab == "scene" else ".hm-ms", timeout=60000)
    page.wait_for_timeout(400)


def client(page, p):
    return page.evaluate("""(p) => { const vp = window.__human.viewport, V = vp.camera.position.constructor, s = vp.project(new V(p[0], p[1], p[2])), r = vp.canvas.getBoundingClientRect();
      return { x: r.left + s.x, y: r.top + s.y, visible: s.visible }; }""", list(p))
