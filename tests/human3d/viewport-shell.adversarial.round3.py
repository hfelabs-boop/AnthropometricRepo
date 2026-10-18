"""Third round of adversarial checks for the Digital human shell (reuses the helpers of viewport-shell.adversarial.py).
    python3 tests/human3d/viewport-shell.adversarial.round3.py <check> ...
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("vsa", HERE / "viewport-shell.adversarial.py")
vsa = importlib.util.module_from_spec(spec)
sys.modules["vsa"] = vsa
spec.loader.exec_module(vsa)
session, open_human, finding, SHOTS, bad_logs = vsa.session, vsa.open_human, vsa.finding, vsa.SHOTS, vsa.bad_logs


def check_retry_inplace_visibility():
    """A start failure that is retried IN PLACE (non-import error) creates a NEW controller; app.js keeps calling onShow/onHide on the OLD one."""
    init = "window.__failRO = true; const RO = window.ResizeObserver; window.ResizeObserver = class { constructor(cb){ if (window.__failRO) throw new Error('boom ro'); return new RO(cb); } };"
    with session(init=init) as (page, logs, base):
        page.goto(base + "/#/human")
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'error'", timeout=60000)
        print("error text:", page.evaluate("document.getElementById('view-human').innerText.slice(0,200)").replace("\n", " | "))
        page.evaluate("window.__failRO = false")
        page.click("#view-human button.btn")
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=90000)
        print("recovered")
        # go to another tab and back
        page.click('a.tab[data-view="about"]')
        page.wait_for_timeout(800)
        st = page.evaluate("({active: window.__human.viewport.active, shown: true})")
        print("after leaving, viewport.active =", st["active"])
        if st["active"]:
            finding("after an in-place Retry of a failed start the new controller never gets onHide/onShow (app.js holds the controller of the failed attempt): the viewport stays active while the tab is hidden")
        # keyboard shortcuts while another tab is shown
        before = page.evaluate("window.__human.viewport.getView().azimuth")
        page.keyboard.press("2")
        page.wait_for_timeout(700)
        after = page.evaluate("window.__human.viewport.getView().azimuth")
        print("azimuth before/after pressing 2 on About:", before, after)
        if abs(before - after) > 1:
            finding("shortcut keys still act on the hidden Digital human view after Retry (shell.shown never cleared)")


def check_start_no_ro():
    """Plain failure then reload of module: ensure the dispose of failed attempt left nothing behind (canvas count, listeners)."""
    init = "window.__failRO = true; const RO = window.ResizeObserver; window.ResizeObserver = class { constructor(cb){ if (window.__failRO) throw new Error('boom ro'); return new RO(cb); } };"
    with session(init=init) as (page, logs, base):
        page.goto(base + "/#/human")
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'error'", timeout=60000)
        n = page.evaluate("document.querySelectorAll('canvas').length")
        print("canvases after failed start:", n)
        if n:
            finding(f"{n} canvas element(s) left after a failed start")


def check_prefs_autodisplay():
    """The auto-enabled skeleton/joints (no skin available) are documented as 'not remembered'; do they leak into hm-prefs?"""
    with session() as (page, logs, base):
        page.add_init_script("try{localStorage.removeItem('hm-prefs')}catch(e){}") if False else None
        open_human(page, base)
        skin = page.evaluate("!!window.__human.state.rig.skin")
        d0 = page.evaluate("JSON.stringify(window.__human.state.display)")
        print("skin:", skin, "display:", d0)
        page.click("button[aria-pressed]:has-text('X-ray')")
        raw = page.evaluate("localStorage.getItem('hm-prefs')")
        print("prefs:", raw)
        if not skin and raw and '"skeleton":true' in raw:
            finding("the automatically enabled Skeleton/Joints display (no skin built) is saved to hm-prefs as soon as the user toggles any other option, contrary to the comment 'once, not remembered' (shell.js:297-300)")


def check_sweep():
    sizes = [(320, 568), (360, 640), (390, 800), (600, 900), (768, 1024), (899, 700), (900, 700), (1024, 768), (1259, 800), (1260, 800), (1280, 800), (1920, 1080), (800, 360)]
    for w, h in sizes:
        with session(w, h, False) as (page, logs, base):
            open_human(page, base)
            page.wait_for_timeout(500)
            m = page.evaluate("""() => { const de = document.documentElement; const bad = []; const vw = de.clientWidth;
              for (const el of document.querySelectorAll('#view-human button, #view-human input, #view-human summary, #view-human a')) { const r = el.getBoundingClientRect(); if (!r.width) continue; const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue;
                let p = el.parentElement, clipped = false; while (p && p.id !== 'view-human') { const o = getComputedStyle(p); if ((o.overflowX !== 'visible') && p.scrollWidth > p.clientWidth + 1) { clipped = true; break; } p = p.parentElement; }
                if (!clipped && (r.right > vw + 1 || r.left < -1)) bad.push((el.className || el.tagName) + ' ' + (el.textContent || '').trim().slice(0, 20) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
              const cv = document.querySelector('.hm-canvas'); const cr = cv && cv.getBoundingClientRect();
              return { sw: de.scrollWidth, cw: vw, bad: bad.slice(0, 8), canvas: cr && [Math.round(cr.width), Math.round(cr.height)] }; }""")
            print(w, h, m)
            if m["sw"] > m["cw"]:
                finding(f"horizontal page scroll at {w}x{h}: scrollWidth {m['sw']} > {m['cw']}")
            if m["bad"]:
                finding(f"controls outside the viewport at {w}x{h}: {m['bad']}")
            if not m["canvas"] or m["canvas"][0] < 200 or m["canvas"][1] < 200:
                finding(f"canvas too small at {w}x{h}: {m['canvas']}")
            page.screenshot(path=str(SHOTS / f"r3-sweep-{w}x{h}.png"))
            bl = bad_logs(logs)
            if bl:
                finding(f"console problems at {w}x{h}: {bl[:3]}")


def check_css_fail():
    """human.css fails to load (flaky network): is the tab still usable, and does a reload-free retry (leave and come back) fix it?"""
    with session() as (page, logs, base):
        state = {"block": True}
        page.route("**/human.css", lambda route, *_: route.abort() if state["block"] else route.continue_())
        page.goto(base + "/#/human")
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready' || document.querySelector('.hm-root')?.dataset.hmState === 'error'", timeout=60000)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "r3-css-fail.png"))
        m = page.evaluate("(() => { const c = document.querySelector('.hm-canvas'); const r = c && c.getBoundingClientRect(); return { state: document.querySelector('.hm-root').dataset.hmState, canvas: r && [Math.round(r.width), Math.round(r.height)], link: !!document.querySelector('link[data-hm-css]') }; })()")
        print("css blocked:", m)
        if not m["canvas"] or m["canvas"][1] < 100:
            finding(f"with human.css failing to load the 3D view collapses to {m['canvas']} (unstyled, unusable tab) and nothing tells the user: {m}")
        state["block"] = False
        page.click('a.tab[data-view="about"]')
        page.wait_for_timeout(300)
        page.click('a.tab[data-view="human"]')
        page.wait_for_timeout(1500)
        m2 = page.evaluate("(() => { const c = document.querySelector('.hm-canvas'); const r = c && c.getBoundingClientRect(); return r && [Math.round(r.width), Math.round(r.height)]; })()")
        print("after unblock and tab round trip:", m2)


def _knee_xy(page):
    return page.evaluate("(() => { const V = window.__human.viewport, R = window.__human.state.rig; const b = V.canvas.getBoundingClientRect(); const s = V.project(R.jointWorld('knee_L')); return [b.left + s.x, b.top + s.y]; })()")


def check_joints_need_xray():
    """With the skin built (default), the Joints toggle shows nothing and joints cannot be hovered or clicked until X-ray is on."""
    with session() as (page, logs, base):
        open_human(page, base)
        if not page.evaluate("!!window.__human.state.rig.skin"):
            print("no skin built: skipped")
            return
        page.evaluate("window.__human.ctx.setDisplay({joints:true})")
        page.wait_for_timeout(500)
        p = _knee_xy(page)
        page.mouse.move(*p); page.wait_for_timeout(300); page.mouse.click(*p); page.wait_for_timeout(300)
        sel = page.evaluate("window.__human.state.selection")
        print("skin on, joints on: selection", sel)
        if sel is None:
            finding("with the skin shown (the default once body.js exists), turning on Joints shows no markers and a click on a joint selects nothing: the markers are depth-tested behind the opaque skin; the Inspector hint 'Turn on Joints, then click a joint marker' leads nowhere until X-ray is also switched on (shell.js:522, :46)")
        page.evaluate("window.__human.ctx.setDisplay({xray:true})"); page.wait_for_timeout(500)
        page.mouse.move(*p); page.wait_for_timeout(300); page.mouse.click(*p); page.wait_for_timeout(300)
        print("xray on: selection", page.evaluate("window.__human.state.selection"))


def check_retry_pick():
    """After a renderer rebuild (Retry) and after a pointer-down / hide / release elsewhere, joint picking still works (X-ray on so the markers are visible)."""
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({joints:true, xray:true})"); page.wait_for_timeout(600)
        box = page.locator(".hm-canvas").bounding_box()
        page.mouse.move(box["x"] + 50, box["y"] + 50); page.mouse.down()
        page.evaluate("location.hash = '#/about'"); page.wait_for_timeout(300)
        page.mouse.up()
        page.evaluate("location.hash = '#/human'"); page.wait_for_timeout(1000)
        p = _knee_xy(page); page.mouse.move(*p); page.wait_for_timeout(200); page.mouse.click(*p); page.wait_for_timeout(300)
        sel = page.evaluate("window.__human.state.selection")
        print("after stale pointer:", sel)
        if not sel:
            finding("stale pointer: a click on a joint does not select it after pointer-down, tab hide and release elsewhere")
        page.evaluate("window.__human.ctx.select(null)")
        page.evaluate("window.__lose = window.__human.viewport.renderer.getContext().getExtension('WEBGL_lose_context'); window.__lose.loseContext()")
        page.wait_for_timeout(500)
        page.click(".hm-vp-msg button"); page.wait_for_timeout(1500)
        p = _knee_xy(page); page.mouse.move(*p); page.wait_for_timeout(200); page.mouse.click(*p); page.wait_for_timeout(300)
        sel = page.evaluate("window.__human.state.selection")
        print("after retry:", sel)
        if not sel:
            finding("after Retry (renderer rebuilt) clicking a joint no longer selects it")


if __name__ == "__main__":
    for n in sys.argv[1:]:
        globals()["check_" + n]()
    sys.exit(1 if vsa.FINDINGS else 0)
