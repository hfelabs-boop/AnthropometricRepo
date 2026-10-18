"""Adversarial checks of the Digital human shell + viewport (site/js/human/index.js, viewport.js) in the REAL site at #/human.

    python3 tests/human3d/viewport-shell.adversarial.py <check> [<check> ...]    (no argument: list the checks; "all" runs every one)

Each check prints findings as "FINDING: ..." lines (a check that finds nothing prints "ok: <name>"). Screenshots go to $SHOTS
(default: the session scratchpad). The checks are deliberately independent of the author's tests (test_viewer.py).
"""
import contextlib
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from playwright.sync_api import sync_playwright  # noqa: E402
import shot  # noqa: E402
from devserver import serve  # noqa: E402

SHOTS = Path(os.environ.get("SHOTS", "/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad"))
SHOTS.mkdir(parents=True, exist_ok=True)
FINDINGS = []


def finding(msg):
    FINDINGS.append(msg)
    print("FINDING:", msg, flush=True)


@contextlib.contextmanager
def session(width=1280, height=800, dark=False, mobile=False, args=None, init=None, reduced=False, debug=True):
    """Chromium + dev server; yields (page, logs, base). `init` is JS run before every page script."""
    with contextlib.ExitStack() as st:
        base = st.enter_context(serve())
        p = st.enter_context(sync_playwright())
        b = p.chromium.launch(executable_path=shot.CHROME, args=args if args is not None else shot.ARGS)
        ctx = b.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", reduced_motion="reduce" if reduced else "no-preference",
                            is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
        if debug:
            ctx.add_init_script("try{localStorage.setItem('hm-debug','1')}catch(e){}")
        if init:
            ctx.add_init_script(init)
        page = ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        try:
            yield page, logs, base
        finally:
            b.close()


def open_human(page, base, hash_="#/human", timeout=90000):
    page.goto(base + "/" + hash_)
    try:
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=timeout)
    except Exception:
        diag = page.evaluate("({state: document.querySelector('.hm-root')?.dataset.hmState, view: document.getElementById('view-human')?.innerText.slice(0, 200), st: window.__human?.state && {busy: window.__human.state.busy, notices: window.__human.state.notices, rig: !!window.__human.state.rig, profile: window.__human.state.profile?.label}})")
        page.screenshot(path=str(SHOTS / "adv-open-timeout.png"))
        finding(f"tab did not reach the ready state within {timeout // 1000} s: {diag}")
        raise


def bad_logs(logs, allow=()):
    out = []
    for l in logs:
        if l.startswith("[error]") or l.startswith("[pageerror]") or l.startswith("[warning]"):
            if any(a in l for a in allow):
                continue
            out.append(l)
    return out


def hscroll(page):
    return page.evaluate("({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth})")


# ----------------------------------------------------------------------------------------------------------------------------- checks
def check_layout():
    for (w, h_, dark) in [(1280, 800, False), (1280, 800, True), (900, 700, False), (900, 700, True), (390, 800, False), (390, 800, True)]:
        with session(w, h_, dark, mobile=(w < 500)) as (page, logs, base):
            open_human(page, base)
            tag = f"{w}x{h_}-{'dark' if dark else 'light'}"
            page.screenshot(path=str(SHOTS / f"adv-layout-{tag}.png"))
            page.screenshot(path=str(SHOTS / f"adv-layout-{tag}-full.png"), full_page=True)
            s = hscroll(page)
            if s["sw"] > s["cw"] + 1:
                finding(f"{tag}: horizontal scroll: scrollWidth {s['sw']} > clientWidth {s['cw']}")
            # elements overflowing the viewport horizontally / controls unreachable
            res = page.evaluate("""() => {
              const out = [];
              const vw = document.documentElement.clientWidth;
              for (const el of document.querySelectorAll('#view-human button, #view-human input, #view-human a, #view-human summary')) {
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) continue;
                let clipped = false;
                for (let p = el.parentElement; p && p.id !== 'view-human'; p = p.parentElement) {
                  const cs = getComputedStyle(p);
                  if (/(auto|scroll|hidden)/.test(cs.overflowX)) { const pr = p.getBoundingClientRect(); if (r.right > pr.right + 1 || r.left < pr.left - 1) { clipped = p.className + (cs.overflowX==='auto'||cs.overflowX==='scroll' ? ' (scrollable)' : ' (CLIPPED)'); break; } }
                }
                if (r.right > vw + 1 || r.left < -1 || clipped) out.push({t: el.tagName, cls: el.className, text: (el.textContent||'').trim().slice(0, 24), l: Math.round(r.left), r: Math.round(r.right), clipped});
              }
              return out;
            }""")
            for r in res:
                if "(scrollable)" in str(r["clipped"]):
                    continue
                finding(f"{tag}: control outside viewport/clipped: {r}")
            # text truncation in status
            tr = page.evaluate("""() => [...document.querySelectorAll('.hm-stat > span:last-child')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent)""")
            if tr:
                print(f"note {tag}: status values ellipsised: {tr}")
            errs = bad_logs(logs)
            if errs:
                finding(f"{tag}: console problems: {errs[:5]}")
            print(tag, "scroll", s, "canvas", page.evaluate("(()=>{const c=document.querySelector('.hm-canvas');const r=c.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height),c.width,c.height]})()"))



def check_keyboard():
    with session() as (page, logs, base):
        open_human(page, base)
        # tab order from the Digital human tab link
        page.focus('a.tab[data-view="human"]')
        order = []
        for _ in range(40):
            page.keyboard.press("Tab")
            d = page.evaluate("""() => { const a = document.activeElement; return a ? (a.tagName + '.' + (a.className||'').toString().split(' ')[0] + (a.dataset.tab ? '[tab=' + a.dataset.tab + ']' : '') + (a.dataset.view ? '[view=' + a.dataset.view + ']' : '') + (a.dataset.value ? '[val=' + a.dataset.value + ']':'') + ' ' + (a.getAttribute('aria-label')||a.textContent||'').trim().slice(0,18)) : null }""")
            order.append(d)
            if d and d.startswith("BODY"):
                break
        print("tab order:", order)
        # tab list: exactly one tab stop
        stops = page.evaluate("[...document.querySelectorAll('.hm-tab')].filter(t => t.tabIndex === 0).length")
        if stops != 1:
            finding(f"tablist has {stops} tab stops (expected 1)")
        for grp in ["Camera view", "Units and tools", "Display options"]:
            n = page.evaluate("(g) => [...document.querySelector(`[aria-label='${g}']`).querySelectorAll('button')].filter(b => b.tabIndex === 0 && !b.disabled).length", grp)
            if n != 1:
                finding(f"toolbar {grp!r} has {n} tab stops")
        # tablist arrows
        page.focus('.hm-tab[data-tab="profile"]')
        page.keyboard.press("ArrowRight")
        sel = page.evaluate("document.querySelector('.hm-tab[aria-selected=true]').dataset.tab + '|' + document.activeElement.dataset.tab + '|' + [...document.querySelectorAll('.hm-panel-body')].filter(p => !p.hidden).map(p => p.id).join()")
        print("after ArrowRight:", sel)
        if not sel.startswith("posture|posture|"):
            finding(f"tablist ArrowRight did not select+focus next tab: {sel}")
        page.keyboard.press("End")
        page.keyboard.press("ArrowRight")
        sel = page.evaluate("document.querySelector('.hm-tab[aria-selected=true]').dataset.tab")
        if sel != "profile":
            finding(f"tablist End then ArrowRight did not wrap to the first tab: {sel}")
        page.keyboard.press("ArrowLeft")
        sel = page.evaluate("document.querySelector('.hm-tab[aria-selected=true]').dataset.tab")
        if sel != "export":
            finding(f"tablist ArrowLeft from first did not wrap: {sel}")
        # tabpanel has aria-labelledby to the tab, and visible one only
        # shortcuts
        page.mouse.click(5, 5)
        page.evaluate("document.activeElement.blur()")
        for k, v in zip("123456", ["front", "back", "left", "right", "top", "iso"]):
            page.keyboard.press(k)
            page.wait_for_timeout(300)
            try:  # SwiftShader frames are slow: wait for the animation to finish
                page.wait_for_function("!window.__human.viewport.getView || (() => { const c = window.__human.viewport; return !c.__busy })()", timeout=100)
            except Exception:
                pass
            page.wait_for_timeout(2500)
            got = page.evaluate("(()=>{const v=window.__human.viewport.getView(); return [Math.round(v.azimuth), Math.round(v.polar*10)/10]})()")
            print("key", k, v, got)
            exp = {"front": (0, 90), "back": (180, 90), "left": (90, 90), "right": (-90, 90), "top": (0, 0.5), "iso": (35, 68)}[v]
            if abs(got[0] - exp[0]) > 1.5 and not (v in ("back",) and abs(abs(got[0]) - 180) < 1.5) or abs(got[1] - exp[1]) > 1.5:
                finding(f"view key {k} -> {got}, expected {exp}")
        # no key capture inside inputs
        page.evaluate("""() => { const i = document.createElement('input'); i.id='adv-input'; i.type='text'; document.querySelector('.hm-panel-body:not([hidden])').append(i); const ta=document.createElement('textarea'); ta.id='adv-ta'; document.body.append(ta); const sel=document.createElement('select'); sel.id='adv-sel'; sel.innerHTML='<option>1</option><option>2</option>'; document.body.append(sel); const ce=document.createElement('div'); ce.id='adv-ce'; ce.contentEditable='true'; ce.textContent='x'; document.body.append(ce); }""")
        before = page.evaluate("window.__human.viewport.getView().azimuth")
        for sel_ in ["#adv-input", "#adv-ta", "#adv-ce"]:
            page.focus(sel_)
            page.keyboard.type("123456fF?")
            page.wait_for_timeout(500)
            a = page.evaluate("window.__human.viewport.getView().azimuth")
            help_open = page.evaluate("!document.querySelector('.hm-help').hidden")
            if abs(a - before) > 0.5 or help_open:
                finding(f"shortcut keys captured while typing in {sel_}: azimuth {before}->{a}, help open {help_open}")
        page.focus("#adv-sel")
        page.keyboard.press("1")
        page.wait_for_timeout(400)
        a = page.evaluate("window.__human.viewport.getView().azimuth")
        if abs(a - before) > 0.5:
            finding("shortcut keys captured while a <select> has focus")
        # shortcuts with modifier keys must not fire
        page.evaluate("document.activeElement.blur()")
        page.keyboard.press("Control+1")
        page.keyboard.press("Alt+f")
        page.wait_for_timeout(300)
        # help: ? opens, Escape closes and restores focus
        page.keyboard.press("?")
        if not page.evaluate("!document.querySelector('.hm-help').hidden"):
            finding("? did not open help")
        page.keyboard.press("Escape")
        if page.evaluate("!document.querySelector('.hm-help').hidden"):
            finding("Escape did not close help")
        # selection: select a joint via ctx then Escape
        page.evaluate("window.__human.ctx.select({kind:'joint', id:'knee_L'})")
        page.keyboard.press("Escape")
        if page.evaluate("window.__human.state.selection") is not None:
            finding("Escape did not clear the selection")
        # Escape inside help with focus in the help dialog
        page.click('button[aria-label="Keyboard and mouse help"]')
        foc = page.evaluate("document.activeElement.className")
        print("focus after opening help:", foc)
        page.keyboard.press("Escape")
        foc = page.evaluate("document.activeElement.getAttribute('aria-label')")
        if foc != "Keyboard and mouse help":
            finding(f"focus not returned to the help button after Escape: {foc}")
        # arrow keys on the canvas pan; not elsewhere; page must not scroll
        page.focus(".hm-canvas")
        t0 = page.evaluate("window.__human.viewport.controls.target.toArray()")
        sy = page.evaluate("scrollY")
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(500)
        t1 = page.evaluate("window.__human.viewport.controls.target.toArray()")
        if t0 == t1:
            finding("arrow keys on the focused canvas do not pan")
        if page.evaluate("scrollY") != sy:
            finding("arrow keys on the canvas scrolled the page")
        page.keyboard.press("Shift+ArrowLeft")
        page.wait_for_timeout(300)
        # Esc while the canvas is focused clears selection
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems during keyboard use: {errs[:4]}")


def check_pointer():
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.viewport.setView('front', {animate:false}); window.__human.ctx.frame(false)")
        page.wait_for_timeout(500)
        box = page.evaluate("(()=>{const r=document.querySelector('.hm-canvas').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        # locate the knee_L marker on screen
        def jointpos(j):
            return page.evaluate("""(j) => { const h = window.__human; const THREE_V = h.viewport.camera.position.clone(); const p = h.state.rig.jointWorld(j, THREE_V.clone()); const q = h.viewport.project(p); const r = document.querySelector('.hm-canvas').getBoundingClientRect(); return [r.left + q.x, r.top + q.y, q.visible]; }""", j)
        kx, ky, vis = jointpos("knee_L")
        print("knee_L at", kx, ky, vis)
        # click selects
        page.mouse.click(kx, ky)
        page.wait_for_timeout(300)
        sel = page.evaluate("window.__human.state.selection")
        if not sel or sel.get("id") != "knee_L":
            finding(f"click on the knee_L marker at {kx:.0f},{ky:.0f} selected {sel}")
        # click empty -> clear
        page.mouse.click(box[0] + 20, box[1] + box[3] / 2)
        page.wait_for_timeout(300)
        if page.evaluate("window.__human.state.selection") is not None:
            finding("click on empty space did not clear the selection")
        # drag from a marker: must not select and must orbit
        before = page.evaluate("window.__human.viewport.getView().azimuth")
        page.mouse.move(kx, ky)
        page.mouse.down()
        page.mouse.move(kx + 60, ky + 5, steps=6)
        page.mouse.up()
        page.wait_for_timeout(600)
        after = page.evaluate("window.__human.viewport.getView().azimuth")
        sel = page.evaluate("window.__human.state.selection")
        if sel:
            finding(f"drag that started on a joint marker selected it: {sel}")
        if abs(after - before) < 1:
            finding(f"drag did not orbit: azimuth {before} -> {after}")
        # a 3 px wobble is still a click (4 px threshold)
        kx, ky, _ = jointpos("knee_L")
        page.mouse.move(kx, ky)
        page.mouse.down()
        page.mouse.move(kx + 2, ky + 2)
        page.mouse.up()
        page.wait_for_timeout(300)
        sel = page.evaluate("window.__human.state.selection")
        print("wobble click selection:", sel)
        # wheel zoom
        d0 = page.evaluate("window.__human.viewport.getView().distance")
        page.mouse.move(box[0] + box[2] / 2, box[1] + box[3] / 2)
        page.mouse.wheel(0, -400)
        page.wait_for_timeout(600)
        d1 = page.evaluate("window.__human.viewport.getView().distance")
        if not d1 < d0 - 0.05:
            finding(f"wheel did not zoom in: {d0} -> {d1}")
        for _ in range(40):
            page.mouse.wheel(0, 2000)
        page.wait_for_timeout(800)
        d2 = page.evaluate("window.__human.viewport.getView().distance")
        if d2 > 12.01:
            finding(f"zoom out beyond maxDistance: {d2}")
        for _ in range(60):
            page.mouse.wheel(0, -2000)
        page.wait_for_timeout(800)
        d3 = page.evaluate("window.__human.viewport.getView().distance")
        if d3 < 0.39:
            finding(f"zoom in beyond minDistance: {d3}")
        # right-drag pan, and pan clamp
        t0 = page.evaluate("window.__human.viewport.controls.target.toArray()")
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        page.mouse.move(cx, cy)
        page.mouse.down(button="right")
        page.mouse.move(cx + 150, cy - 80, steps=8)
        page.mouse.up(button="right")
        page.wait_for_timeout(600)
        t1 = page.evaluate("window.__human.viewport.controls.target.toArray()")
        if t0 == t1:
            finding("right-drag did not pan")
        for _ in range(30):
            page.mouse.move(cx, cy)
            page.mouse.down(button="right")
            page.mouse.move(cx - 300, cy + 200, steps=3)
            page.mouse.up(button="right")
        page.wait_for_timeout(800)
        t2 = page.evaluate("window.__human.viewport.controls.target.toArray()")
        print("pan target after hammering:", t2)
        if any(abs(v) > 6.01 for v in (t2[0], t2[2])) or t2[1] < -0.01 or t2[1] > 3.01:
            finding(f"pan target escaped the clamp: {t2}")
        # polar clamp: drag down hard
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx, cy - 600, steps=10)
        page.mouse.up()
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx, cy + 1200, steps=10)
        page.mouse.up()
        page.wait_for_timeout(800)
        v = page.evaluate("window.__human.viewport.getView()")
        print("polar after extreme drags", v["polar"])
        if v["polar"] > 100.5 or v["polar"] < -0.01:
            finding(f"polar angle outside limits: {v['polar']}")
        # NaN check
        nan = page.evaluate("(()=>{const c=window.__human.viewport.camera; return [c.position.x,c.position.y,c.position.z,c.quaternion.x,c.projectionMatrix.elements[0]].some(v=>!Number.isFinite(v))})()")
        if nan:
            finding("camera has NaN after extreme interaction")
        # dblclick frames
        page.mouse.dblclick(cx, cy)
        page.wait_for_timeout(900)
        d = page.evaluate("window.__human.viewport.getView().distance")
        print("distance after dblclick", d)
        # touch (pointerType touch) hover must not highlight; context menu on right click prevented?
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems during pointer use: {errs[:4]}")
        page.screenshot(path=str(SHOTS / "adv-pointer-end.png"))


# JS probes installed before any page script: rAF accounting, listener / observer / media-query bookkeeping, WebGL context bookkeeping.
PROBE = r"""
(() => {
  const P = window.__probe = { raf: 0, rafLive: new Set(), obs: new Set(), ctxs: [], lis: new Map(), mql: new Set(), timers: 0, errors: [] };
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (f) => { P.raf++; let id; id = raf((t) => { P.rafLive.delete(id); f(t); }); P.rafLive.add(id); return id; };
  window.cancelAnimationFrame = (id) => { P.rafLive.delete(id); caf(id); };
  for (const N of ["ResizeObserver", "MutationObserver", "IntersectionObserver"]) {
    const O = window[N]; if (!O) continue;
    window[N] = class extends O {
      constructor(...a) { super(...a); this.__live = true; P.obs.add(this); this.__n = N; }
      observe(...a) { this.__obsd = true; return super.observe(...a); }
      disconnect() { P.obs.delete(this); return super.disconnect(); }
    };
  }
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const ids = new WeakMap(); let nid = 0;
  const idOf = (f) => { if (!f) return 0; if (!ids.has(f)) ids.set(f, ++nid); return ids.get(f); };
  const tname = (t) => t === window ? "window" : t === document ? "document" : t instanceof MediaQueryList ? "mql:" + t.media : t instanceof HTMLCanvasElement ? "canvas" : t.nodeType ? "node" : "other";
  EventTarget.prototype.addEventListener = function (type, fn, opt) {
    const cap = typeof opt === "object" ? !!opt?.capture : !!opt;
    if (fn) { let m = P.lis.get(this); if (!m) P.lis.set(this, m = new Map()); m.set(type + "|" + cap + "|" + idOf(typeof fn === "function" ? fn : fn.handleEvent), tname(this)); if (typeof opt === "object" && opt?.once) { /* approximate: once listeners self-remove */ const k = type + "|" + cap + "|" + idOf(fn); const wrapped = fn; fn = function (...a) { m.delete(k); return wrapped.apply(this, a); }; } }
    return add.call(this, type, fn, opt);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opt) {
    const cap = typeof opt === "object" ? !!opt?.capture : !!opt;
    P.lis.get(this)?.delete(type + "|" + cap + "|" + idOf(typeof fn === "function" ? fn : fn?.handleEvent));
    return rem.call(this, type, fn, opt);
  };
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...a) { const c = gc.call(this, t, ...a); if (c && /webgl/.test(t)) P.ctxs.push({ canvas: this, gl: c }); return c; };
  P.snapshot = () => {
    const lis = {};
    for (const [t, m] of P.lis) { const n = tname(t); if (n === "window" || n === "document" || n.startsWith("mql") || (n === "canvas" || n === "node") && t.isConnected) { for (const [k, nm] of m) { lis[nm + ":" + k.split("|")[0]] = (lis[nm + ":" + k.split("|")[0]] || 0) + 1; } } }
    const obs = {}; for (const o of P.obs) if (o.__obsd) obs[o.__n] = (obs[o.__n] || 0) + 1;
    return { raf: P.raf, rafLive: P.rafLive.size, lis, obs, canvases: document.querySelectorAll("canvas").length,
      liveCtx: P.ctxs.filter((c) => { try { return !c.gl.isContextLost(); } catch { return false; } }).length, totalCtx: P.ctxs.length };
  };
})();
"""


def diff(a, b):
    out = {}
    for k in set(a) | set(b):
        if isinstance(a.get(k), dict) or isinstance(b.get(k), dict):
            for kk in set(a.get(k, {})) | set(b.get(k, {})):
                d = b.get(k, {}).get(kk, 0) - a.get(k, {}).get(kk, 0)
                if d:
                    out[f"{k}.{kk}"] = d
        elif isinstance(a.get(k, 0), (int, float)):
            d = b.get(k, 0) - a.get(k, 0)
            if d:
                out[k] = d
    return out


def check_visibility():
    """Pause on hide, resume on show, repeated round trips (leaks of canvases / contexts / listeners / observers / rAF loops)."""
    with session(init=PROBE) as (page, logs, base):
        open_human(page, base)
        page.wait_for_timeout(1500)
        # idle: no rAF loop
        a = page.evaluate("__probe.raf")
        page.wait_for_timeout(1500)
        b = page.evaluate("__probe.raf")
        print("idle rAF calls in 1.5 s:", b - a)
        if b - a > 3:
            finding(f"render loop is not idle: {b - a} requestAnimationFrame calls in 1.5 s with nothing happening")
        # orbit with damping then hide immediately
        box = page.evaluate("(()=>{const r=document.querySelector('.hm-canvas').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 120, cy + 20, steps=5); page.mouse.up()
        page.evaluate("location.hash = '#/catalog'")
        page.wait_for_timeout(600)
        a = page.evaluate("__probe.raf"); live = page.evaluate("[...__probe.rafLive].length")
        page.wait_for_timeout(1500)
        b = page.evaluate("__probe.raf"); live2 = page.evaluate("[...__probe.rafLive].length")
        hidden = page.evaluate("document.getElementById('view-human').hidden")
        print("hidden:", hidden, "rAF calls while hidden in 1.5 s:", b - a, "live", live, live2)
        if b - a > 3:
            finding(f"{b - a} requestAnimationFrame calls in 1.5 s while the Digital human tab is hidden (some may be the site's; check)")
        # resize the window while hidden, change theme while hidden, then come back
        page.set_viewport_size({"width": 1000, "height": 700})
        page.click("#theme-toggle")
        page.wait_for_timeout(300)
        page.evaluate("location.hash = '#/human'")
        page.wait_for_timeout(1500)
        info = page.evaluate("(()=>{const h=window.__human; const c=document.querySelector('.hm-canvas'); const r=c.getBoundingClientRect(); return {cw:c.width, ch:c.height, rw:Math.round(r.width), rh:Math.round(r.height), bg:h.viewport.scene.background.getHexString(), dark: h.viewport.theme.dark, active: h.viewport.active}})()")
        print("after return:", info)
        if info["cw"] != info["rw"] or info["ch"] != info["rh"]:
            finding(f"canvas backing size {info['cw']}x{info['ch']} does not match its CSS size {info['rw']}x{info['rh']} after returning to the tab")
        if not info["active"]:
            finding("viewport still inactive after returning to the tab")
        page.screenshot(path=str(SHOTS / "adv-after-return-theme.png"))
        base0 = page.evaluate("__probe.snapshot()")
        for i in range(12):
            page.evaluate("location.hash = '#/about'")
            page.wait_for_timeout(120)
            page.evaluate("location.hash = '#/human'")
            page.wait_for_timeout(120)
        page.wait_for_timeout(1000)
        base1 = page.evaluate("__probe.snapshot()")
        d = diff(base0, base1)
        print("snapshot", base0, "\ndiff after 12 round trips:", d)
        leaks = {k: v for k, v in d.items() if k not in ("raf",) and v > 0}
        if leaks:
            finding(f"resources grew over 12 tab round trips: {leaks}")
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")


def check_lifecycle():
    """disposeHuman() + initHuman() repeated: no canvases, contexts, listeners, observers left behind."""
    with session(init=PROBE) as (page, logs, base):
        open_human(page, base)
        page.wait_for_timeout(800)
        snaps = []
        for i in range(4):
            r = page.evaluate_handle("""async () => { const m = await import('/js/human/index.js'); m.disposeHuman(); return true }""")
            page.wait_for_timeout(300)
            snaps.append(("disposed", page.evaluate("__probe.snapshot()")))
            page.evaluate("""async () => { const m = await import('/js/human/index.js'); await m.initHuman(); }""")
            page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=90000)
            page.wait_for_timeout(500)
            snaps.append(("rebuilt", page.evaluate("__probe.snapshot()")))
        for n, s_ in snaps:
            print(n, json.dumps(s_))
        disposed = [s_ for n, s_ in snaps if n == "disposed"]
        rebuilt = [s_ for n, s_ in snaps if n == "rebuilt"]
        if any(s_["canvases"] != 0 for s_ in disposed):
            finding(f"canvas elements remain after disposeHuman(): {[s_['canvases'] for s_ in disposed]}")
        if any(s_["liveCtx"] > 1 for s_ in disposed):
            finding(f"WebGL contexts not released by disposeHuman(): live counts {[s_['liveCtx'] for s_ in disposed]}")
        d = diff(disposed[0], disposed[-1])
        if any(v > 0 for k, v in d.items() if k != "raf" and k != "totalCtx"):
            finding(f"listeners/observers grow across dispose cycles: {d}")
        d2 = diff(rebuilt[0], rebuilt[-1])
        if any(v > 0 for k, v in d2.items() if k not in ("raf", "totalCtx")):
            finding(f"resources grow across rebuilt tabs: {d2}")
        if any(s_["rafLive"] > 2 for s_ in disposed):
            finding(f"pending rAF callbacks after dispose: {[s_['rafLive'] for s_ in disposed]}")
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")


def check_nowebgl():
    """WebGL unavailable (flag-based and stubbed getContext): the tab must explain, stay usable, never throw."""
    variants = {
        "flags": dict(args=["--disable-gpu", "--disable-software-rasterizer", "--disable-3d-apis"]),
        "stub": dict(init="(()=>{const g=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(t,...a){ if(/webgl/.test(t)) return null; return g.call(this,t,...a)}; delete window.WebGLRenderingContext; delete window.WebGL2RenderingContext;})()"),
    }
    for name, kw in variants.items():
        with session(**kw) as (page, logs, base):
            page.goto(base + "/#/human")
            page.wait_for_function("document.querySelector('.hm-root')", timeout=60000)
            page.wait_for_timeout(2500)
            msg = page.evaluate("document.querySelector('.hm-vp-msg')?.textContent || null")
            print(name, "message:", msg)
            st = page.evaluate("document.querySelector('.hm-root').dataset.hmState")
            print(name, "state:", st)
            page.screenshot(path=str(SHOTS / f"adv-nowebgl-{name}.png"))
            if not msg:
                finding(f"[{name}] no plain-language message when WebGL is unavailable")
            if not page.evaluate("!!document.querySelector('.hm-vp-msg [role], .hm-vp-msg')?.getAttribute('role')"):
                finding(f"[{name}] message has no role=alert")
            # every control must still be operable without throwing
            page.evaluate("document.querySelectorAll('.hm-bar button').forEach(b => { try { b.click() } catch (e) { console.error('click failed ' + e) } })")
            page.keyboard.press("1"); page.keyboard.press("f"); page.keyboard.press("?"); page.keyboard.press("Escape")
            q = page.evaluate("(()=>{const b=document.querySelector('.hm-quality'); const r=b.getBoundingClientRect(); const top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); const bars=[...document.querySelectorAll('.hm-bar button')].map(b=>{const r=b.getBoundingClientRect(); const e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return e===b || b.contains(e)}); return {quality: top===b, bars: bars.filter(Boolean).length + '/' + bars.length}})()")
            print(name, "pointer-reachable:", q)
            page.locator(".hm-stat").last.screenshot(path=str(SHOTS / f"adv-nowebgl-{name}-status.png"))
            if not q["quality"]:
                finding(f"[{name}] the Quality toggle in the status bar is covered/clipped (not clickable with the pointer)")
            if q["bars"].split("/")[0] != q["bars"].split("/")[1]:
                finding(f"[{name}] toolbar buttons covered by the WebGL error message (reachable {q['bars']}): the message overlay (z-index 5) sits above the toolbars (z-index 2)")
            page.evaluate("document.querySelector('.hm-quality').click()")
            page.wait_for_timeout(800)
            for t in ["Posture", "Scene", "Export"]:
                page.click(f'.hm-tab:has-text("{t}")')
            page.evaluate("location.hash='#/about'"); page.wait_for_timeout(300); page.evaluate("location.hash='#/human'"); page.wait_for_timeout(500)
            gl = page.evaluate("document.querySelector('.hm-gl').textContent")
            print(name, "status:", gl)
            if "unavailable" not in gl.lower():
                finding(f"[{name}] status bar does not say WebGL is unavailable: {gl!r}")
            # Retry button
            if page.query_selector(".hm-vp-msg button"):
                page.click(".hm-vp-msg button")
                page.wait_for_timeout(800)
                n = page.evaluate("document.querySelectorAll('.hm-vp-msg').length")
                if n != 1:
                    finding(f"[{name}] after Retry there are {n} messages (expected exactly 1)")
            sc = page.evaluate("(async()=>{ const b=document.querySelector('button[aria-label=\"Save a screenshot\"]'); b.click(); await new Promise(r=>setTimeout(r,500)); return document.querySelector('.toast')?.textContent || document.body.innerText.includes('nothing to save') })()")
            print(name, "screenshot click ->", sc)
            errs = bad_logs(logs, allow=("404", "WebGL", "webgl", "GPU stall", "context"))
            if errs:
                finding(f"[{name}] console problems: {errs[:5]}")
            print(name, "all logs:", [l for l in logs][:8])
            # the model must still be built in the background; selection etc must not throw
            print(name, "rig:", page.evaluate("!!window.__human.state.rig"))


def check_contextloss():
    with session(init=PROBE) as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__lc = window.__human.viewport.renderer.getContext().getExtension('WEBGL_lose_context')")
        page.evaluate("window.__lc.loseContext()")
        page.wait_for_timeout(800)
        msg = page.evaluate("document.querySelector('.hm-vp-msg')?.textContent || null")
        print("message after loss:", msg)
        if not msg:
            finding("no message after WebGL context loss")
        page.screenshot(path=str(SHOTS / "adv-contextlost.png"))
        # interact while lost
        page.evaluate("document.querySelectorAll('.hm-bar button').forEach(b => b.click())")
        page.keyboard.press("2")
        box = page.evaluate("(()=>{const r=document.querySelector('.hm-canvas').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        page.mouse.click(box[0] + 100, box[1] + 100)
        page.mouse.move(box[0] + 100, box[1] + 100); page.mouse.down(); page.mouse.move(box[0] + 200, box[1] + 120, steps=4); page.mouse.up()
        page.wait_for_timeout(300)
        page.evaluate("window.__lc.restoreContext()")
        page.wait_for_timeout(1500)
        msg = page.evaluate("document.querySelector('.hm-vp-msg')?.textContent || null")
        if msg:
            finding(f"message still shown after the context was restored: {msg[:60]}")
        lost = page.evaluate("window.__human.viewport.info()")
        print("info after restore:", lost)
        page.screenshot(path=str(SHOTS / "adv-contextrestored.png"))
        # does it render again? look at the pixels: read the canvas through screenshot()
        stats = page.evaluate("""() => { const v = window.__human.viewport; const url = v.screenshot({labels:false}); return new Promise(res => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; const set = new Set(); for (let k = 0; k < d.length; k += 4 * 97) set.add(d[k] + ',' + d[k+1] + ',' + d[k+2]); res({w: c.width, colors: set.size}); }; i.src = url; }) }""")
        print("pixel variety after restore:", stats)
        if stats["colors"] < 8:
            finding(f"canvas looks blank after context restore (distinct colours {stats['colors']})")
        # lose again then Retry
        page.evaluate("window.__human.viewport.renderer.getContext().getExtension('WEBGL_lose_context').loseContext()")
        page.wait_for_timeout(500)
        page.click(".hm-vp-msg button")
        page.wait_for_timeout(1500)
        snap = page.evaluate("__probe.snapshot()")
        print("after retry:", snap["canvases"], snap["liveCtx"], snap["totalCtx"])
        if snap["canvases"] != 1:
            finding(f"{snap['canvases']} canvases after Retry")
        if snap["liveCtx"] != 1:
            finding(f"{snap['liveCtx']} live WebGL contexts after Retry")
        stats = page.evaluate("""() => { const v = window.__human.viewport; const url = v.screenshot({labels:false}); return new Promise(res => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; const set = new Set(); for (let k = 0; k < d.length; k += 4 * 97) set.add(d[k] + ',' + d[k+1] + ',' + d[k+2]); res({w: c.width, colors: set.size}); }; i.src = url; }) }""")
        if stats["colors"] < 8:
            finding(f"canvas blank after Retry rebuild (distinct colours {stats['colors']})")
        page.screenshot(path=str(SHOTS / "adv-retry.png"))
        # lost while hidden, restored while hidden
        page.evaluate("location.hash='#/about'")
        page.wait_for_timeout(300)
        page.evaluate("(()=>{const e=window.__human.viewport.renderer.getContext().getExtension('WEBGL_lose_context'); window.__lc=e; e.loseContext();})()")
        page.wait_for_timeout(300)
        page.evaluate("window.__lc.restoreContext()")
        page.wait_for_timeout(600)
        page.evaluate("location.hash='#/human'")
        page.wait_for_timeout(1500)
        stats = page.evaluate("""() => { const v = window.__human.viewport; const url = v.screenshot({labels:false}); return new Promise(res => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; const set = new Set(); for (let k = 0; k < d.length; k += 4 * 97) set.add(d[k] + ',' + d[k+1] + ',' + d[k+2]); res({w: c.width, colors: set.size}); }; i.src = url; }) }""")
        if stats["colors"] < 8:
            finding(f"canvas blank after loss+restore while the tab was hidden ({stats})")
        errs = bad_logs(logs, allow=("404", "CONTEXT_LOST", "context lost", "Context Lost"))
        if errs:
            finding(f"console problems around context loss: {errs[:5]}")


def check_theme():
    with session() as (page, logs, base):
        open_human(page, base)
        def grab(tag):
            page.screenshot(path=str(SHOTS / f"adv-theme-{tag}.png"))
            return page.evaluate("(()=>{const h=window.__human; const t=h.viewport.theme; const cs=getComputedStyle(document.querySelector('.hm-viewport')); return {dark:t.dark, bg:'#'+h.viewport.scene.background.getHexString(), css: cs.backgroundColor, ui: h.state.theme.dark, tok: getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim(), label: getComputedStyle(document.querySelector('.hm-label')||document.body).color}})()")
        a = grab("light")
        page.click("#theme-toggle"); page.wait_for_timeout(700)
        b = grab("dark")
        page.click("#theme-toggle"); page.wait_for_timeout(700)
        c = grab("light2")
        print(a, b, c, sep="\n")
        if not b["dark"] or b["bg"] == a["bg"]:
            finding(f"scene did not follow a switch to dark: {a['bg']} -> {b['bg']}")
        if c["dark"] or c["bg"] != a["bg"]:
            finding(f"scene did not return to light: {a['bg']} -> {c['bg']}")
        if not b["ui"]:
            finding("state.theme.dark not updated")
        # OS preference change while no explicit theme is stored
        page.evaluate("document.documentElement.removeAttribute('data-theme'); localStorage.removeItem('theme')")
        page.emulate_media(color_scheme="dark"); page.wait_for_timeout(700)
        d = grab("os-dark")
        page.emulate_media(color_scheme="light"); page.wait_for_timeout(700)
        e = grab("os-light")
        if not d["dark"] or e["dark"]:
            finding(f"scene did not follow prefers-color-scheme changes: dark={d['dark']} light={e['dark']}")
        # pixel check that the canvas really shows the dark background after a switch
        page.click("#theme-toggle"); page.wait_for_timeout(600)
        px = page.evaluate("""() => { const v = window.__human.viewport; const url = v.screenshot({labels:false}); return new Promise(res => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 2, 2, 1, 1, 0, 0, 1, 1); res([...g.getImageData(0,0,1,1).data]); }; i.src = url; }) }""")
        print("corner pixel after toggle:", px, "dark", page.evaluate("window.__human.viewport.theme.dark"))
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")


def check_profilefail():
    """Default profile load failures: aborted, 404, invalid JSON, hanging; the tab must show a figure + notice (or at least say what happens)."""
    modes = {
        "abort": lambda route: route.abort(),
        "404": lambda route: route.fulfill(status=404, body="nope"),
        "badjson": lambda route: route.fulfill(status=200, content_type="application/json", body="{not json"),
        "emptyindex": lambda route: route.fulfill(status=200, content_type="application/json", body='{"populations": []}'),
        "weirdindex": lambda route: route.fulfill(status=200, content_type="application/json", body='{"populations": null}'),
        "nullindex": lambda route: route.fulfill(status=200, content_type="application/json", body='null'),
    }
    for name, handler in modes.items():
        with session() as (page, logs, base):
            page.route("**/api/v1/**", handler)
            page.goto(base + "/#/human")
            try:
                page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=60000)
            except Exception:
                stt = page.evaluate("document.querySelector('.hm-root')?.dataset.hmState")
                finding(f"[{name}] the tab never reached the ready state; state={stt}")
                page.screenshot(path=str(SHOTS / f"adv-profilefail-{name}.png"))
                continue
            page.wait_for_timeout(500)
            info = page.evaluate("({n: window.__human.state.notices.map(n => n.level + ': ' + n.text), prof: window.__human.state.profile?.label, rig: !!window.__human.state.rig, stature: window.__human.state.profile?.measures?.stature?.value})")
            print(name, info)
            if not info["rig"]:
                finding(f"[{name}] no figure after the default profile failed to load")
            if not any(n.startswith("warn") or n.startswith("error") for n in info["n"]):
                finding(f"[{name}] profile failure produced no visible notice")
            page.screenshot(path=str(SHOTS / f"adv-profilefail-{name}.png"))
            errs = bad_logs(logs, allow=("404", "ERR_FAILED", "Failed to load resource"))
            if errs:
                finding(f"[{name}] console problems: {errs[:3]}")
    # hanging request: what does the user see?
    with session() as (page, logs, base):
        page.route("**/api/v1/index.json", lambda route: None)  # never answered
        page.goto(base + "/#/human")
        page.wait_for_function("document.querySelector('.hm-root')", timeout=60000)
        page.wait_for_timeout(9000)
        st = page.evaluate("({state: document.querySelector('.hm-root').dataset.hmState, rig: !!window.__human.state.rig, busy: window.__human.state.busy, notices: window.__human.state.notices.length, status: document.querySelector('.hm-stat-grow').textContent, spinner: !document.querySelector('.hm-busy').hidden})")
        print("hang after 9 s:", st)
        page.screenshot(path=str(SHOTS / "adv-profilefail-hang.png"))
        if not st["rig"] and st["notices"] == 0 and not st["spinner"]:
            finding("when api/v1/index.json never answers the tab shows an empty stage with no spinner, no notice and no timeout (status says 'loading...' forever)")


def check_race():
    with session(init=PROBE) as (page, logs, base):
        open_human(page, base)
        res = page.evaluate("""async () => {
          const h = window.__human, anthro = await import('/js/human/anthro.js');
          const rigMod = await import('/js/human/rig.js');
          // count rig disposals
          const disposed = [], created = [];
          const proto = Object.getPrototypeOf(h.state.rig);
          const od = proto.dispose;
          proto.dispose = function () { disposed.push(this); return od.call(this); };
          const mk = (st) => anthro.manualProfile({ sex: 'M', stature: st, mass: 70 + (st - 1600) / 10 });
          const out = {};
          // 1. burst of debounced changes
          const ps = [];
          for (let s = 1500; s <= 1900; s += 25) ps.push(h.ctx.setProfile(mk(s)));
          const r = await Promise.all(ps);
          out.burstResults = r.map(x => x.ok + '/' + !!x.fallback).join(',');
          out.finalStature = h.state.profile.measures.stature.value;
          out.rigHeight = (() => { const b = h.state.rig.body; return b.stature ?? null; })();
          out.groupsInScene = h.viewport.scene.children.filter(c => c.name === 'rig' || c.isGroup && c.children.length > 5).length;
          // 2. immediate changes interleaved
          const q = [];
          for (let i = 0; i < 6; i++) q.push(h.ctx.setProfile(mk(1550 + i * 50), { immediate: true }));
          const r2 = await Promise.all(q);
          out.immediate = r2.map(x => x.ok).join(',');
          out.finalStature2 = h.state.profile.measures.stature.value;
          out.rigStature2 = h.state.rig.body.stature ?? h.state.body.stature;
          // 3. quality flips during builds
          h.ctx.setQuality('low'); h.ctx.setQuality('high'); h.ctx.setQuality('low');
          await new Promise(r => setTimeout(r, 1500));
          out.quality = h.state.quality;
          await h.pipeline.rebuild();
          out.disposedCount = disposed.length;
          out.disposedIsCurrent = disposed.includes(h.state.rig);
          out.busy = h.state.busy;
          out.pending = h.pipeline.pending;
          out.rigsInScene = h.viewport.scene.children.filter(c => c === h.state.rig.group).length;
          out.allGroups = h.viewport.scene.children.map(c => c.type + ':' + (c.name || '')).join(' ');
          out.mem = h.viewport.renderer.info.memory;
          out.programs = h.viewport.renderer.info.programs?.length;
          return out;
        }""")
        print(json.dumps(res, indent=1))
        if "false" in res["burstResults"].split(",")[0:0]:
            pass
        if res["rigsInScene"] != 1:
            finding(f"{res['rigsInScene']} copies of the current rig group in the scene")
        if res["disposedIsCurrent"]:
            finding("the current rig was disposed")
        if abs(res["finalStature2"] - 1800) > 0.01:
            finding(f"final profile is not the last requested: {res['finalStature2']}")
        if res["busy"] or res["pending"]:
            finding(f"pipeline still busy after everything settled: busy={res['busy']} pending={res['pending']}")
        # memory growth check: rebuild 8x and compare geometry/texture counts
        m0 = page.evaluate("({...window.__human.viewport.renderer.info.memory, programs: window.__human.viewport.renderer.info.programs.length})")
        for i in range(8):
            page.evaluate("window.__human.pipeline.rebuild()")
            page.wait_for_timeout(500)
            page.evaluate("window.__human.viewport.renderNow()")
        page.wait_for_timeout(800)
        m1 = page.evaluate("({...window.__human.viewport.renderer.info.memory, programs: window.__human.viewport.renderer.info.programs.length})")
        print("GPU memory before/after 8 rebuilds:", m0, m1)
        if m1["geometries"] > m0["geometries"] + 2 or m1["textures"] > m0["textures"] + 2:
            finding(f"GPU resources grow across rebuilds: {m0} -> {m1}")
        snap = page.evaluate("__probe.snapshot()")
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems during the race: {errs[:4]}")
        # a profile whose build throws in the middle of a burst
        r = page.evaluate("""async () => {
          const h = window.__human, anthro = await import('/js/human/anthro.js');
          const bad = { id: 'bad', label: 'bad profile', sex: 'M', source: { kind: 'manual' }, measures: { stature: { value: NaN, unit: 'mm', status: 'edited' }, mass: { value: -5, unit: 'kg', status: 'edited' } }, notes: [] };
          const before = h.state.rig;
          const res = await h.ctx.setProfile(bad, { immediate: true });
          const after = h.state.rig;
          const msg = h.state.notices.map(n => n.text);
          const lastTry = await h.ctx.setProfile(anthro.manualProfile({ sex: 'F', stature: 1650, mass: 60 }), { immediate: true });
          return { res: { ok: res.ok, fb: res.fallback }, kept: after === before, replaced: after !== before, msg, last: lastTry.ok, h: !!h.state.rig, st: h.state.profile.label };
        }""")
        print("bad profile:", r)
        if not r["h"]:
            finding("no rig after a bad profile followed by a good one")



def check_views():
    """Screenshots of every preset (light, labels on), selection, hover, help, inspector; geometry sanity of presets."""
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({labels:true, landmarks:true, com:true})")
        page.wait_for_timeout(600)
        for name in ["front", "back", "left", "right", "top", "iso"]:
            page.evaluate(f"window.__human.ctx.setView('{name}')")
            page.wait_for_timeout(900)
            page.locator(".hm-stage").screenshot(path=str(SHOTS / f"adv-view-{name}.png"))
            v = page.evaluate("(()=>{const v=window.__human.viewport; const c=v.camera; return {pos:c.position.toArray().map(x=>+x.toFixed(2)), up:c.up.toArray(), look: v.controls.target.toArray().map(x=>+x.toFixed(2))}})()")
            print(name, v)
        # figure fully visible in each framed view? project head/foot
        for name in ["front", "left", "top"]:
            page.evaluate(f"window.__human.ctx.setView('{name}', {{animate:false}}); window.__human.ctx.frame(false)")
            page.wait_for_timeout(500)
            r = page.evaluate("""(()=>{const h=window.__human; const pts=h.state.rig.labelAnchors().map(a=>a.position); const b=new (h.viewport.camera.position.constructor)(); const out=[]; const bb={minx:1e9,maxx:-1e9,miny:1e9,maxy:-1e9}; for (const id of ['head','ankle_L','ankle_R','shoulder_L','shoulder_R','hip_L','wrist_L','wrist_R']) { const p=h.state.rig.jointWorld(id); const q=h.viewport.project(p); bb.minx=Math.min(bb.minx,q.x); bb.maxx=Math.max(bb.maxx,q.x); bb.miny=Math.min(bb.miny,q.y); bb.maxy=Math.max(bb.maxy,q.y);} const c=h.viewport.canvas.getBoundingClientRect(); return {bb, w:c.width, h:c.height}})()""")
            print("framed", name, r)
            if r["bb"]["minx"] < 0 or r["bb"]["maxx"] > r["w"] or r["bb"]["miny"] < 0 or r["bb"]["maxy"] > r["h"]:
                finding(f"Fit in {name} view leaves joints outside the canvas: {r}")
        page.evaluate("window.__human.ctx.setView('iso', {animate:false}); window.__human.ctx.frame(false)")
        page.evaluate("window.__human.ctx.select({kind:'joint', id:'elbow_L'})")
        page.wait_for_timeout(700)
        page.screenshot(path=str(SHOTS / "adv-selected-elbow.png"))
        page.evaluate("window.__human.ctx.setDisplay({labels:false, landmarks:false, com:false})")
        # hover tooltip
        pos = page.evaluate("(()=>{const h=window.__human; const q=h.viewport.project(h.state.rig.jointWorld('knee_R')); const r=h.viewport.canvas.getBoundingClientRect(); return [r.left+q.x, r.top+q.y]})()")
        page.mouse.move(pos[0] - 80, pos[1]); page.mouse.move(pos[0], pos[1], steps=4)
        page.wait_for_timeout(500)
        tip = page.evaluate("(()=>{const t=document.querySelector('.hm-tip'); return t.hidden ? null : t.textContent})()")
        print("tooltip:", tip)
        if not tip:
            finding("no hover tooltip over a joint marker")
        page.screenshot(path=str(SHOTS / "adv-hover.png"))
        # inspector toggle + help
        page.click(".hm-inspector-x"); page.wait_for_timeout(500)
        page.click('button[aria-label="Keyboard and mouse help"]'); page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "adv-help-inspector-closed.png"))
        s_ = hscroll(page)
        if s_["sw"] > s_["cw"] + 1:
            finding("horizontal scroll with inspector closed")


def check_quality():
    with session() as (page, logs, base):
        open_human(page, base)
        print("initial quality:", page.evaluate("window.__human.state.quality"), page.evaluate("window.__human.viewport.info()"))
        for i in range(3):
            page.click(".hm-quality")
            page.wait_for_timeout(1200)
            print(page.evaluate("({q: window.__human.state.quality, vq: window.__human.viewport.quality, dpr: window.__human.viewport.info().pixelRatio, rig: !!window.__human.state.rig, label: document.querySelector('.hm-quality').textContent, ls: localStorage.getItem('hm-prefs')})"))
        # persisted prefs reload
        page.reload()
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=90000)
        print("after reload:", page.evaluate("({q: window.__human.state.quality, u: window.__human.state.units, d: window.__human.state.display})"))
        # corrupt prefs
        page.evaluate("localStorage.setItem('hm-prefs', '{\"units\":\"furlong\",\"display\":{\"skin\":\"yes\",\"grid\":false},\"quality\":7}')")
        page.reload()
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=90000)
        st = page.evaluate("({q: window.__human.state.quality, u: window.__human.state.units, d: window.__human.state.display})")
        print("corrupt prefs:", st)
        if st["u"] != "mm":
            finding(f"corrupt units pref accepted: {st['u']}")
        page.evaluate("localStorage.setItem('hm-prefs', 'not json')")
        page.reload()
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=90000)
        # blocked storage
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")
    with session(init="Object.defineProperty(window, 'localStorage', {get(){ throw new DOMException('denied', 'SecurityError') }})") as (page, logs, base):
        open_human(page, base)
        page.click('.hm-chip:has-text("Labels")')
        page.click('.hm-seg button[data-value=cm]')
        page.wait_for_timeout(400)
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems with blocked storage: {errs[:4]}")
        print("blocked storage ok")


def check_reduced():
    with session(reduced=True) as (page, logs, base):
        open_human(page, base)
        r = page.evaluate("({damp: window.__human.viewport.controls.enableDamping})")
        print(r)
        if r["damp"]:
            finding("damping enabled under prefers-reduced-motion")
        t0 = page.evaluate("performance.now()")
        page.evaluate("window.__human.ctx.setView('back')")
        page.wait_for_timeout(60)
        az = page.evaluate("window.__human.viewport.getView().azimuth")
        if abs(abs(az) - 180) > 1:
            finding(f"view change animates under reduced motion (azimuth {az} 60 ms after)")
        # CSS transitions
        anim = page.evaluate("[...document.querySelectorAll('.hm-root *')].filter(e => { const s = getComputedStyle(e); return parseFloat(s.transitionDuration) > 0 || parseFloat(s.animationDuration) > 0 }).map(e => e.className).slice(0,5)")
        if anim:
            finding(f"CSS transitions/animations under reduced motion: {anim}")
        # live toggle: switch to no-preference
        page.emulate_media(reduced_motion="no-preference")
        page.wait_for_timeout(300)
        r = page.evaluate("window.__human.viewport.controls.enableDamping")
        if not r:
            finding("damping not re-enabled after prefers-reduced-motion turned off")


def check_screenshot():
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({labels:true})")
        page.wait_for_timeout(500)
        with page.expect_download(timeout=20000) as dl:
            page.click('button[aria-label="Save a screenshot"]')
        d = dl.value
        out = SHOTS / "adv-download.png"
        d.save_as(str(out))
        print("download:", d.suggested_filename, out.stat().st_size)
        if out.stat().st_size < 2000:
            finding("screenshot download is tiny / blank")
        toast = page.evaluate("[...document.querySelectorAll('.toast, [role=status]')].map(e=>e.textContent).join('|')")
        print("toast/status:", toast[:100])



def check_mobile():
    with session(390, 800, False, mobile=True) as (page, logs, base):
        open_human(page, base)
        page.evaluate("document.querySelector('.hm-stage').scrollIntoView()")
        page.wait_for_timeout(500)
        page.evaluate("window.__human.ctx.frame(false)")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "adv-mobile-stage.png"))
        pos = page.evaluate("(()=>{const h=window.__human; const q=h.viewport.project(h.state.rig.jointWorld('knee_L')); const r=h.viewport.canvas.getBoundingClientRect(); return [r.left+q.x, r.top+q.y, q.visible, r.top, r.bottom]})()")
        print("knee at", pos)
        page.touchscreen.tap(pos[0], pos[1])
        page.wait_for_timeout(500)
        sel = page.evaluate("window.__human.state.selection")
        print("tap selection:", sel)
        if not sel:
            finding(f"tap on a joint marker did not select it on a touch device (at {pos})")
        # tap does not show a sticky tooltip
        tip = page.evaluate("!document.querySelector('.hm-tip').hidden")
        if tip:
            finding("hover tooltip stays visible after a tap on touch")
        # toolbars scrollable and chip sizes
        sizes = page.evaluate("[...document.querySelectorAll('.hm-bar button, .hm-tab, .hm-quality, .hm-inspector-x')].map(b => { const r = b.getBoundingClientRect(); return [b.textContent.trim().slice(0,12) || b.getAttribute('aria-label'), Math.round(r.width), Math.round(r.height)] }).filter(x => x[2] < 32)")
        print("small touch targets (<32px high):", sizes)
        if sizes:
            finding(f"touch targets under 32px: {sizes[:6]}")
        # the page can still be scrolled by dragging on the canvas? touch-action none -> no; report info only
        ta = page.evaluate("getComputedStyle(document.querySelector('.hm-canvas')).touchAction")
        print("canvas touch-action:", ta)
        # inspector toggle
        page.evaluate("document.querySelector('.hm-inspector-x').scrollIntoView()")
        page.tap(".hm-inspector-x")
        page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / "adv-mobile-inspector.png"))
        s_ = hscroll(page)
        if s_["sw"] > s_["cw"] + 1:
            finding("horizontal scroll on mobile after opening the inspector")
        # help on mobile
        page.evaluate("document.querySelector('.hm-stage').scrollIntoView()")
        page.evaluate("document.querySelector('.hm-bar-top .hm-group:last-child').scrollIntoView({inline:'end'})")
        page.tap('button[aria-label="Keyboard and mouse help"]')
        page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / "adv-mobile-help.png"))
        r = page.evaluate("(()=>{const e=document.querySelector('.hm-help').getBoundingClientRect(); return {l:e.left,r:e.right,t:e.top,b:e.bottom,vw:innerWidth,vh:innerHeight}})()")
        print("help rect", r)
        if r["l"] < 0 or r["r"] > r["vw"] + 1:
            finding(f"help dialog outside the viewport on mobile: {r}")
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")


CONTRAST_JS = r"""
() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d', { willReadFrequently: true });
  const parse = (c) => { g.clearRect(0,0,1,1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0,0,1,1); const d = g.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3]/255]; };
  // canvas fillStyle with alpha over transparent: premultiplied loss, so re-parse alpha from the string when rgba
  const parseA = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; } const m2 = /color\(srgb ([^)]+)\)/.exec(c); if (m2) { const p = m2[1].split(/[ \/]+/).map(Number); return [p[0]*255, p[1]*255, p[2]*255, p.length > 3 ? p[3] : 1]; } return parse(c); };
  const lum = ([r,g_,b]) => { const f = (v) => { v/=255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4 }; return .2126*f(r)+.7152*f(g_)+.0722*f(b); };
  const over = (top, bot) => { const a = top[3]; return [top[0]*a + bot[0]*(1-a), top[1]*a + bot[1]*(1-a), top[2]*a + bot[2]*(1-a), 1]; };
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const c = parseA(getComputedStyle(e).backgroundColor); if (c[3] > 0) { chain.push(c); if (c[3] >= 1) break; } } let base = parseA(getComputedStyle(document.body).backgroundColor); if (base[3] < 1) base = [255,255,255,1]; for (const c of chain.reverse()) base = over(c, base); return base; };
  const out = [];
  for (const el of document.querySelectorAll('#view-human *')) {
    if (el.closest('.hm-viewport') && !el.classList.contains('hm-label') && !el.closest('.hm-vp-msg')) continue;
    const txt = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (!txt) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const fg = parseA(cs.color); const bg = bgOf(el); const fgc = over(fg, bg);
    const L1 = lum(fgc), L2 = lum(bg); const ratio = (Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700;
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < need) out.push({ text: txt.slice(0, 30), cls: el.className.toString().slice(0, 30), ratio: +ratio.toFixed(2), need, fg: cs.color, size });
  }
  return out;
}
"""


def check_a11y():
    for dark in (False, True):
        with session(dark=dark) as (page, logs, base):
            open_human(page, base)
            th = "dark" if dark else "light"
            page.evaluate("window.__human.ctx.setDisplay({labels:true})")
            page.evaluate("window.__human.ctx.select({kind:'joint', id:'knee_L'})")
            page.wait_for_timeout(700)
            low = page.evaluate(CONTRAST_JS)
            print(th, "low-contrast text:", json.dumps(low)[:1500])
            for x in low:
                finding(f"[{th}] low contrast text {x}")
            # focus indicators
            page.evaluate("document.activeElement.blur()")
            page.focus('a.tab[data-view="human"]')
            seen = []
            for _ in range(30):
                page.keyboard.press("Tab")
                r = page.evaluate("""() => { const a = document.activeElement; if (!a || !a.closest('#view-human')) return null; const cs = getComputedStyle(a); const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'; return { id: a.tagName + '.' + a.className.toString().split(' ')[0] + ' ' + (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 20), ring, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, inline: a.style.outline } }""")
                if r:
                    seen.append(r)
                    if not r["ring"]:
                        finding(f"[{th}] no visible focus indicator on {r['id']} (outline {r['outline']}, inline outline {r['inline']!r})")
            print(th, "focusable controls seen:", len(seen))
            page.focus(".hm-canvas")
            page.keyboard.press("Shift+Tab"); page.keyboard.press("Tab")
            page.screenshot(path=str(SHOTS / f"adv-focus-canvas-{th}.png"))
            # ARIA references
            bad = page.evaluate("""() => { const out = []; for (const e of document.querySelectorAll('#view-human [aria-controls], #view-human [aria-labelledby]')) for (const a of ['aria-controls', 'aria-labelledby']) { const v = e.getAttribute(a); if (v) for (const id of v.split(' ')) if (!document.getElementById(id)) out.push(a + '->' + id); } const ids = [...document.querySelectorAll('#view-human [id]')].map(e => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); return { out, dup }; }""")
            print(th, "aria:", bad)
            if bad["out"] or bad["dup"]:
                finding(f"[{th}] broken/duplicate ARIA ids: {bad}")
            # buttons without accessible names
            nn = page.evaluate("""() => [...document.querySelectorAll('#view-human button, #view-human [role=tab], #view-human input, #view-human summary')].filter(b => !((b.getAttribute('aria-label') || b.textContent || b.title || '').trim())).map(b => b.outerHTML.slice(0, 80))""")
            if nn:
                finding(f"[{th}] controls without accessible name: {nn}")
            # toggle buttons: pressed states exposed
            pr = page.evaluate("[...document.querySelectorAll('.hm-bar-bottom .hm-chip')].map(b => b.getAttribute('aria-pressed'))")
            print(th, "aria-pressed:", pr)


def check_idle_after_drag():
    with session(init=PROBE) as (page, logs, base):
        open_human(page, base)
        box = page.evaluate("(()=>{const r=document.querySelector('.hm-canvas').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 200, cy + 30, steps=10); page.mouse.up()
        page.wait_for_timeout(9000)  # damping decays per frame and SwiftShader frames are slow
        a = page.evaluate("__probe.raf"); page.wait_for_timeout(1500); b = page.evaluate("__probe.raf")
        print("rAF per 1.5 s after damped drag:", b - a)
        if b - a > 3:
            finding(f"render loop keeps running after the camera stopped: {b-a} rAF in 1.5 s")
        # hover: constant mouse movement shouldn't render when nothing under it
        a = page.evaluate("__probe.raf")
        for i in range(30):
            page.mouse.move(cx + i, cy - 100)
        page.wait_for_timeout(500)
        b = page.evaluate("__probe.raf")
        print("rAF during 30 mouse moves over empty space:", b - a)
        # label update on every render: cost
        t = page.evaluate("""() => { const v = window.__human.viewport; window.__human.ctx.setDisplay({labels:true, landmarks:true}); const t0 = performance.now(); for (let i = 0; i < 20; i++) v.renderNow(); return (performance.now() - t0) / 20 }""")
        print("ms per renderNow (software GL, labels+landmarks):", t)
        # gizmo
        r = page.evaluate("""async () => {
          const THREE = await import('three'); const h = window.__human, v = h.viewport;
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0xff8800 }));
          m.position.set(0.8, 0.2, 0); v.add(m);
          const ev = [];
          for (const t of ['gizmo-start', 'gizmo-change', 'gizmo-end', 'click-unhandled', 'click']) v.on(t, (e) => ev.push(t));
          v.attachGizmo(m, { mode: 'translate', space: 'world', snap: { translate: 0.05 } });
          v.renderNow();
          return { ok: !!v.gizmo, pos: m.position.toArray() };
        }""")
        print("gizmo attach:", r)
        page.wait_for_timeout(500)
        page.evaluate("window.__m = window.__human.viewport.scene.children.find(c => c.isMesh && c.geometry.type === 'BoxGeometry')")
        # find the gizmo X arrow on screen: project object centre + 0.25 along X
        pt = page.evaluate("""() => { const v = window.__human.viewport; const m = window.__m; const q = v.project(m.position.clone().add({x: 0.0, y: 0, z: 0, clone(){return this}})); const r = v.canvas.getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; }""")
        print("box on screen at", pt)
        page.screenshot(path=str(SHOTS / "adv-gizmo.png"))
        sel0 = page.evaluate("(window.__human.ctx.select({kind:'joint', id:'knee_L'}), window.__human.state.selection)")
        # drag from the box centre-right (gizmo X arrow) 80px
        page.mouse.move(pt[0] + 40, pt[1]); page.mouse.down(); page.mouse.move(pt[0] + 120, pt[1], steps=8); page.mouse.up()
        page.wait_for_timeout(500)
        res = page.evaluate("({pos: window.__m.position.toArray(), sel: window.__human.state.selection, enabled: window.__human.viewport.controls.enabled, dragging: window.__human.viewport.gizmoDragging})")
        print("after gizmo drag:", res, "selection before", sel0)
        if res["pos"][0] == 0.8:
            print("note: gizmo drag did not move the box (maybe missed the handle)")
        if not res["enabled"]:
            finding("orbit controls stay disabled after a gizmo drag")
        v0 = page.evaluate("window.__human.viewport.getView().azimuth")
        page.mouse.move(cx - 200, cy - 100); page.mouse.down(); page.mouse.move(cx - 120, cy - 100, steps=5); page.mouse.up()
        page.wait_for_timeout(500)
        v1 = page.evaluate("window.__human.viewport.getView().azimuth")
        if abs(v1 - v0) < 0.5:
            finding("orbit does not work after using the gizmo")
        # detach and dispose cleanliness
        page.evaluate("window.__human.viewport.detachGizmo()")
        page.evaluate("window.__human.viewport.remove(window.__m)")
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")


def check_apifuzz():
    with session() as (page, logs, base):
        open_human(page, base)
        r = page.evaluate("""async () => {
          const THREE = await import('three'); const h = window.__human, v = h.viewport; const out = {};
          const camOK = () => [...v.camera.position.toArray(), ...v.controls.target.toArray(), v.camera.aspect, v.camera.projectionMatrix.elements[0]].every(Number.isFinite);
          const tryit = async (name, f) => { try { await f(); out[name] = camOK() ? 'ok' : 'NaN camera'; } catch (e) { out[name] = 'throws ' + e.message.slice(0, 50); } if (!camOK()) { v.moveTo(new THREE.Vector3(2, 2, 3), new THREE.Vector3(0, 0.9, 0), { animate: false }); } };
          await tryit('frame NaN box', () => v.frame(new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(1, 1, 1)), { animate: false }));
          await tryit('frame Infinity box', () => v.frame(new THREE.Box3(new THREE.Vector3(-Infinity, 0, 0), new THREE.Vector3(Infinity, 1, 1)), { animate: false }));
          await tryit('frame huge box', () => v.frame(new THREE.Box3(new THREE.Vector3(-1e9, 0, 0), new THREE.Vector3(1e9, 1, 1)), { animate: false }));
          await tryit('frame zero box', () => v.frame(new THREE.Box3(new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1)), { animate: false }));
          await tryit('frame null', () => v.frame(null));
          await tryit('frame empty group', () => v.frame(new THREE.Group()));
          await tryit('frame animated NaN', () => v.frame(new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(1, 1, 1)), { animate: true }));
          await tryit('setView bogus', () => v.setView('bogus'));
          await tryit('setView undefined', () => v.setView());
          await tryit('setView distance NaN', () => v.setView('front', { distance: NaN, animate: false }));
          await tryit('moveTo NaN', () => v.moveTo(new THREE.Vector3(NaN, 1, 1), new THREE.Vector3(0, 0, 0), { animate: false }));
          await tryit('pick NaN', () => v.pick(NaN, NaN, h.state.rig.group));
          await tryit('pick null targets', () => v.pick(10, 10, null));
          await tryit('project NaN', () => v.project(new THREE.Vector3(NaN, 0, 0)));
          await tryit('project array', () => v.project([0, 1, 0]));
          await tryit('setQuality junk', () => v.setQuality(5));
          await tryit('resize storm', () => { for (let i = 0; i < 50; i++) v.resize(); });
          await tryit('setActive storm', () => { for (let i = 0; i < 50; i++) v.setActive(i % 2 === 0); v.setActive(true); });
          await tryit('attachGizmo null', () => v.attachGizmo(null));
          await tryit('attachGizmo detached obj', () => v.attachGizmo(new THREE.Object3D()));
          await tryit('detachGizmo twice', () => { v.detachGizmo(); v.detachGizmo(); });
          await tryit('add null', () => v.add(null));
          await tryit('remove not-added', () => v.remove(new THREE.Object3D()));
          await tryit('label source throws', () => { v.addLabelSource('bad', () => { throw new Error('boom'); }); v.renderNow(); v.renderNow(); v.removeLabelSource('bad'); });
          await tryit('label NaN pos', () => { v.addLabelSource('nan', () => [{ id: 'a', text: 'NaN label', position: new THREE.Vector3(NaN, 1, 1) }, { id: 'b', text: 'ok', position: [0, 1, 0] }, { id: 'c', text: '', position: [0, 1, 0] }, null]); v.renderNow(); out.nanLabelDOM = [...v.overlay.querySelectorAll('.hm-label')].map(e => e.textContent + '@' + e.style.transform).join('|'); v.removeLabelSource('nan'); });
          await tryit('on junk', () => { v.on('click', null); });
          await tryit('screenshot', () => { const u = v.screenshot(); if (!u || !u.startsWith('data:image/png')) throw new Error('bad screenshot'); });
          await tryit('screenshot no labels', () => { const u = v.screenshot({ labels: false }); if (!u) throw new Error('bad'); });
          await tryit('theme', () => v.setTheme());
          await tryit('setGrid', () => { v.setGrid(false); v.setGrid(true); });
          // dispose twice then use
          return out;
        }""")
        for k, vv in r.items():
            print(f"  {k}: {vv}")
        for k, vv in r.items():
            if vv == "NaN camera":
                finding(f"viewport API leaves the camera with NaN after: {k}")
        errs = bad_logs(logs, allow=("404",))
        print("console:", errs[:6])
        # dispose twice then use API
        r2 = page.evaluate("""async () => {
          const THREE = await import('three'); const h = window.__human, v = h.viewport; const out = {};
          const vp = v; const m = await import('/js/human/index.js'); m.disposeHuman(); m.disposeHuman();
          for (const [n, f] of Object.entries({ requestRender: () => vp.requestRender(), setActive: () => vp.setActive(true), setView: () => vp.setView('front'), frame: () => vp.frame(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1))), screenshot: () => vp.screenshot(), info: () => vp.info(), resize: () => vp.resize(), pick: () => vp.pick(1, 1, []), project: () => vp.project([0, 0, 0]), dispose: () => vp.dispose(), rebuild: () => vp.rebuild(), add: () => vp.add(new THREE.Object3D()), setTheme: () => vp.setTheme(), attach: () => vp.attachGizmo(new THREE.Object3D()) })) {
            try { f(); out[n] = 'ok'; } catch (e) { out[n] = 'throws ' + e.message.slice(0, 60); }
          }
          return out;
        }""")
        print("after dispose:", r2)
        for k, vv in r2.items():
            if vv.startswith("throws"):
                finding(f"viewport.{k}() throws after dispose: {vv}")
        page.wait_for_timeout(500)
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems after API fuzzing: {errs[:4]}")


def check_hiddenbuild():
    """The default profile arrives while the tab is hidden: the figure must be built, framed and visible when the tab is shown."""
    with session() as (page, logs, base):
        def slow(route):
            time.sleep(4)
            route.continue_()
        page.route("**/api/v1/index.json", slow)
        page.goto(base + "/#/human")
        page.wait_for_function("document.querySelector('.hm-root')", timeout=60000)
        page.evaluate("location.hash = '#/about'")
        page.wait_for_timeout(9000)
        st = page.evaluate("({rig: !!window.__human.state.rig, active: window.__human.viewport.active, hidden: document.getElementById('view-human').hidden})")
        print("while hidden:", st)
        page.evaluate("location.hash = '#/human'")
        page.wait_for_timeout(2000)
        st = page.evaluate("""(()=>{const h = window.__human, v = h.viewport; const q = (id) => { const p = v.project(h.state.rig.jointWorld(id)); return [Math.round(p.x), Math.round(p.y), p.visible] }; const c = v.canvas.getBoundingClientRect(); return { rig: !!h.state.rig, active: v.active, head: q('head'), ankle: q('ankle_L'), dist: v.getView().distance, w: Math.round(c.width), h: Math.round(c.height), cw: v.canvas.width } })()""")
        print("after show:", st)
        page.screenshot(path=str(SHOTS / "adv-hiddenbuild.png"))
        if not st["rig"]:
            finding("no figure after the tab was shown again (build finished while hidden)")
        else:
            if not (st["head"][2] and st["ankle"][2]):
                finding(f"figure not framed in view after a build that completed while the tab was hidden: {st}")
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")


def check_dpr():
    with contextlib.ExitStack() as st:
        base = st.enter_context(serve())
        p = st.enter_context(sync_playwright())
        b = p.chromium.launch(executable_path=shot.CHROME, args=shot.ARGS)
        ctx = b.new_context(viewport={"width": 900, "height": 700}, device_scale_factor=3)
        ctx.add_init_script("localStorage.setItem('hm-debug','1')")
        page = ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.goto(base + "/#/human")
        page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=90000)
        page.wait_for_timeout(800)
        r = page.evaluate("(()=>{const c=document.querySelector('.hm-canvas'); const r=c.getBoundingClientRect(); return {cw:c.width, ch:c.height, rw:r.width, rh:r.height, dpr:devicePixelRatio, q: window.__human.state.quality}})()")
        print(r)
        exp = min(3, 2) if r["q"] == "high" else 1
        if abs(r["cw"] - round(r["rw"] * exp)) > 2:
            finding(f"pixel ratio not as documented at dpr 3, quality {r['q']}: canvas {r['cw']} for css {r['rw']}")
        # live zoom change (browser zoom) -> resize
        page.evaluate("window.__human.viewport.setQuality('high')")
        page.wait_for_timeout(600)
        r = page.evaluate("(()=>{const c=document.querySelector('.hm-canvas'); const r=c.getBoundingClientRect(); return {cw:c.width, rw:r.width}})()")
        print("high:", r)
        if abs(r["cw"] - round(r["rw"] * 2)) > 2:
            finding(f"high quality at dpr 3 should cap at 2x: {r}")
        # live window resize
        page.set_viewport_size({"width": 390, "height": 800})
        page.wait_for_timeout(800)
        r = page.evaluate("(()=>{const c=document.querySelector('.hm-canvas'); const r=c.getBoundingClientRect(); return {cw:c.width, ch:c.height, rw:r.width, rh:r.height}})()")
        print("after resize to 390:", r)
        if abs(r["cw"] - round(r["rw"] * 2)) > 2 or abs(r["ch"] - round(r["rh"] * 2)) > 2:
            finding(f"canvas backing size stale after window resize: {r}")
        page.set_viewport_size({"width": 1280, "height": 800})
        page.wait_for_timeout(800)
        r = page.evaluate("(()=>{const c=document.querySelector('.hm-canvas'); const r=c.getBoundingClientRect(); return {cw:c.width, ch:c.height, rw:r.width, rh:r.height}})()")
        print("after resize to 1280:", r)
        if abs(r["cw"] - round(r["rw"] * 2)) > 2 or abs(r["ch"] - round(r["rh"] * 2)) > 2:
            finding(f"canvas backing size stale after window resize back: {r}")
        page.screenshot(path=str(SHOTS / "adv-dpr3.png"))
        b.close()


def check_anim():
    with session(init=PROBE) as (page, logs, base):
        open_human(page, base)
        for seq in [["back", "left", "right", "top", "iso", "front"], ["top", "front", "top", "front"]]:
            for name in seq:
                page.click(f'button[data-view="{name}"]')
                page.wait_for_timeout(40)
            page.wait_for_timeout(1800)
            v = page.evaluate("window.__human.viewport.getView()")
            exp = {"front": (0, 90), "back": (180, 90), "left": (90, 90), "right": (-90, 90), "top": (0, 0.5), "iso": (35, 68)}[seq[-1]]
            print(seq[-1], round(v["azimuth"], 1), round(v["polar"], 1))
            if abs(v["polar"] - exp[1]) > 1.5:
                finding(f"rapid view clicks ended in the wrong view: {seq} -> azimuth {v['azimuth']:.1f} polar {v['polar']:.1f}")
        # drag during animation: animation must be cancelled
        page.click('button[data-view="back"]')
        page.wait_for_timeout(60)
        box = page.evaluate("(()=>{const r=document.querySelector('.hm-canvas').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 30, cy, steps=3); page.mouse.up()
        page.wait_for_timeout(9000)  # damping decays per frame; SwiftShader frames are slow
        a1 = page.evaluate("window.__human.viewport.getView().azimuth")
        page.wait_for_timeout(1200)
        a2 = page.evaluate("window.__human.viewport.getView().azimuth")
        if abs(a1 - a2) > 0.5:
            finding("camera still moving long after a drag interrupted a view animation (animation not cancelled)")
        # hide during animation
        page.click('button[data-view="front"]')
        page.wait_for_timeout(80)
        page.evaluate("location.hash = '#/about'")
        page.wait_for_timeout(600)
        live = page.evaluate("__probe.rafLive.size")
        a = page.evaluate("__probe.raf"); page.wait_for_timeout(1200); b = page.evaluate("__probe.raf")
        print("rAF while hidden after interrupted animation:", b - a, "live", live)
        if b - a > 2:
            finding("animation loop keeps running after the tab was hidden mid-animation")
        page.evaluate("location.hash = '#/human'")
        page.wait_for_timeout(1000)
        v = page.evaluate("window.__human.viewport.getView()")
        print("after return:", v["azimuth"], v["polar"])
        errs = bad_logs(logs, allow=("404",))
        if errs:
            finding(f"console problems: {errs[:4]}")


def check_panels():
    good = """export default { id: 'posture', label: 'Posture', order: 2, mount(el, ctx) {
      window.__pl = window.__pl || { show: 0, hide: 0, disposed: 0, mounts: 0, ctx: null }; window.__pl.mounts++; window.__pl.ctx = ctx;
      el.textContent = 'panel body'; const off = ctx.on('rig', () => { window.__pl.rig = (window.__pl.rig || 0) + 1; });
      ctx.inspector('posture inspector', { title: 'Posture details' });
      return { onShow() { window.__pl.show++; }, onHide() { window.__pl.hide++; }, dispose() { window.__pl.disposed++; off(); } }; } };"""
    with session() as (page, logs, base):
        page.route("**/js/human/panels/posture.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body=good))
        page.route("**/js/human/panels/scene.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body="export default { id: 'scene', mount() { throw new Error('mount exploded'); } };"))
        page.route("**/js/human/panels/measure.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body="export default {{{ syntax error"))
        page.route("**/js/human/panels/skeleton.js*", lambda r: r.fulfill(status=404, body="no"))
        page.route("**/js/human/panels/analysis.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body="export default { id: 'analysis' };"))
        page.route("**/js/human/panels/export.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body="export default { id: 'export', mount() { return new Promise(() => {}); } };"))
        open_human(page, base)
        def tab(t):
            page.click(f'.hm-tab[data-tab="{t}"]')
            page.wait_for_timeout(700)
        tab("posture")
        pl = page.evaluate("window.__pl")
        print("posture mounted:", pl and {k: v for k, v in pl.items() if k != 'ctx'})
        ititle = page.evaluate("document.getElementById('hm-inspector-title').textContent + '|' + document.getElementById('hm-inspector-body').textContent")
        print("inspector:", ititle)
        if "Posture details" not in ititle:
            finding(f"panel inspector content not shown: {ititle}")
        if pl["show"] != 1:
            finding(f"onShow count after first open is {pl['show']} (expected 1)")
        tab("profile"); tab("posture")
        pl = page.evaluate("window.__pl")
        print("after profile->posture:", {k: v for k, v in pl.items() if k != 'ctx'})
        if pl["show"] != 2 or pl["hide"] != 1:
            finding(f"onShow/onHide counts wrong after switching panels: show={pl['show']} hide={pl['hide']}")
        page.evaluate("location.hash='#/about'"); page.wait_for_timeout(500)
        pl = page.evaluate("window.__pl")
        if pl["hide"] != 2:
            finding(f"panel onHide not called when leaving the Digital human view: {pl['hide']}")
        page.evaluate("location.hash='#/human'"); page.wait_for_timeout(800)
        pl = page.evaluate("window.__pl")
        if pl["show"] != 3:
            finding(f"panel onShow not called when returning to the view: {pl['show']}")
        # rig event reaches panel
        page.evaluate("window.__human.pipeline.rebuild()"); page.wait_for_timeout(1500)
        print("rig events:", page.evaluate("window.__pl.rig"))
        # a panel throws in mount
        tab("scene")
        txt = page.evaluate("document.querySelector('#hm-tab-panel-scene').innerText")
        print("scene:", txt[:200].replace("\n", " | "))
        if "could not" not in txt.lower():
            finding("a panel whose mount() throws shows no error message")
        if not page.query_selector("#hm-tab-panel-scene button"):
            finding("no Retry button for a failed panel")
        tab("measure")
        txt = page.evaluate("document.querySelector('#hm-tab-panel-measure').innerText")
        print("measure (syntax error):", txt[:200].replace("\n", " | "))
        if "coming soon" in txt.lower():
            finding("a panel with a syntax error is reported as 'Coming soon' instead of an error")
        tab("skeleton")
        txt = page.evaluate("document.querySelector('#hm-tab-panel-skeleton').innerText")
        print("skeleton (404):", txt[:120].replace("\n", " | "))
        tab("analysis")
        txt = page.evaluate("document.querySelector('#hm-tab-panel-analysis').innerText")
        print("analysis (no mount):", txt[:160].replace("\n", " | "))
        if "could not" not in txt.lower():
            finding("a panel module without mount() shows no error")
        tab("export")
        txt = page.evaluate("document.querySelector('#hm-tab-panel-export').innerText")
        print("export (never mounts):", txt[:100].replace("\n", " | "))
        # retry of scene: fix route and click retry
        page.unroute("**/js/human/panels/scene.js*")
        page.route("**/js/human/panels/scene.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body="export default { id: 'scene', mount(el) { el.textContent = 'scene fixed'; } };"))
        tab("scene")
        page.click("#hm-tab-panel-scene button")
        page.wait_for_timeout(1000)
        txt = page.evaluate("document.querySelector('#hm-tab-panel-scene').innerText")
        print("scene after retry:", txt[:80])
        if "scene fixed" not in txt:
            finding(f"Retry of a failed panel did not recover: {txt[:80]!r}")
        # switch quickly while a panel is loading
        for t in ["profile", "posture", "scene", "measure", "skeleton", "analysis", "export"] * 3:
            page.evaluate(f"document.querySelector('.hm-tab[data-tab=\"{t}\"]').click()")
        page.wait_for_timeout(800)
        vis = page.evaluate("[...document.querySelectorAll('.hm-panel-body')].filter(p => !p.hidden).length")
        if vis != 1:
            finding(f"{vis} tab panels visible at once")
        # dispose calls the panels
        page.evaluate("import('/js/human/index.js').then(m => m.disposeHuman())"); page.wait_for_timeout(400)
        pl = page.evaluate("window.__pl")
        if pl["disposed"] != 1:
            finding(f"panel dispose() called {pl['disposed']} times on shell dispose")
        print("console:", [l for l in logs if "pageerror" in l or "[error]" in l][:6])


def check_layout2():
    for (w, h_, mobile) in [(320, 568, True), (700, 900, False), (768, 1024, False), (1099, 700, False), (1100, 700, False), (1920, 1080, False), (1280, 500, False)]:
        with session(w, h_, False, mobile=mobile) as (page, logs, base):
            open_human(page, base)
            tag = f"{w}x{h_}"
            page.screenshot(path=str(SHOTS / f"adv-layout2-{tag}.png"))
            s_ = hscroll(page)
            r = page.evaluate("""() => { const c = document.querySelector('.hm-canvas').getBoundingClientRect(); const st = document.querySelector('.hm-stage').getBoundingClientRect(); const l = document.querySelector('.hm-left').getBoundingClientRect(); const bars = [...document.querySelectorAll('.hm-bar')].map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.height), b.scrollWidth > b.clientWidth + 1] }); return { canvas: [Math.round(c.width), Math.round(c.height)], stage: [Math.round(st.width), Math.round(st.height)], left: [Math.round(l.width), Math.round(l.height)], bars } }""")
            print(tag, s_, r)
            if s_["sw"] > s_["cw"] + 1:
                finding(f"{tag}: horizontal scroll ({s_})")
            if r["canvas"][1] < 250 or r["canvas"][0] < 250:
                finding(f"{tag}: the 3D canvas is tiny: {r['canvas']}")
            # toolbar overlap with each other: top bar groups overlapping on the stage
            ov = page.evaluate("""() => { const gs = [...document.querySelectorAll('.hm-bar .hm-group')].map(g => g.getBoundingClientRect()); let o = 0; for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) { const a = gs[i], b = gs[j]; if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) o++; } return o }""")
            if ov:
                finding(f"{tag}: toolbar groups overlap each other ({ov} pairs)")
            # toolbar covering the figure at the stage: figure head/feet within canvas and not behind bars
            cov = page.evaluate("""() => { const h = window.__human, v = h.viewport; const c = v.canvas.getBoundingClientRect(); const out = []; for (const id of ['head', 'ankle_L']) { const p = v.project(h.state.rig.jointWorld(id)); const x = c.left + p.x, y = c.top + p.y; const e = document.elementFromPoint(x, y); out.push([id, Math.round(x), Math.round(y), e && e.closest('.hm-bar') ? 'COVERED by toolbar' : 'ok']); } return out }""")
            print(tag, cov)
            for c_ in cov:
                if c_[3] != "ok":
                    finding(f"{tag}: initial framing puts {c_[0]} under a toolbar: {cov}")



def check_inspector_focus():
    """A panel's inspector node must survive pose events (sliders in it are being dragged while the rig changes)."""
    good = """export default { id: 'posture', label: 'Posture', order: 2, mount(el, ctx) {
      const inp = document.createElement('input'); inp.type = 'range'; inp.id = 'adv-slider'; inp.min = 0; inp.max = 100; inp.value = 10;
      const num = document.createElement('input'); num.type = 'number'; num.id = 'adv-num'; const box = document.createElement('div'); box.append(inp, num);
      window.__node = box;
      inp.addEventListener('input', () => ctx.getRig().setAngles({ knee_L: [Number(inp.value)] }));
      ctx.inspector(box, { title: 'Posture details' }); el.textContent = 'x'; } };"""
    with session() as (page, logs, base):
        page.route("**/js/human/panels/posture.js*", lambda r: r.fulfill(status=200, content_type="text/javascript", body=good))
        open_human(page, base)
        page.click('.hm-tab[data-tab="posture"]'); page.wait_for_timeout(600)
        page.evaluate("window.__human.ctx.select({kind:'joint', id:'knee_L'})"); page.wait_for_timeout(300)
        page.focus("#adv-slider")
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(300)
        act = page.evaluate("document.activeElement.id")
        same = page.evaluate("document.getElementById('hm-inspector-body').firstChild === window.__node")
        print("active after slider input with pose event:", act, "same node", same)
        if act != "adv-slider":
            finding("a panel's inspector node is re-inserted on every 'pose' event (index.js:339/486 replaceChildren): the focused control inside it loses focus (and a mouse drag on a range input is cancelled) while the pose changes")
        page.focus("#adv-num")
        page.keyboard.type("5")
        page.evaluate("window.__human.state.rig.setAngles({ knee_L: [12] })")
        page.wait_for_timeout(200)
        act = page.evaluate("document.activeElement.id")
        if act != "adv-num":
            finding(f"typing in an inspector field is interrupted by a pose event (focus on {act!r})")


def check_carryover():
    with session() as (page, logs, base):
        open_human(page, base)
        r = page.evaluate("""async () => {
          const h = window.__human, a = await import('/js/human/anthro.js'); const out = {};
          const rig = h.state.rig;
          rig.setAngles({ knee_L: [40], hip_L: [30, 0, 0], elbow_R: [90] });
          rig.setRoot({ y: rig.root.y - rig.lowestY() }); // ground it
          h.ctx.select({ kind: 'joint', id: 'knee_L' });
          out.before = { y: rig.root.y, low: rig.lowestY(), knee: rig.angles.knee_L[0], stat: rig.body.stature ?? null };
          await h.ctx.setProfile(a.manualProfile({ sex: 'M', stature: 1950, mass: 100 }), { immediate: true });
          const r2 = h.state.rig;
          out.tall = { y: r2.root.y, low: r2.lowestY(), knee: r2.angles.knee_L[0], hip: r2.angles.hip_L[0], elbow: r2.angles.elbow_R[0], sel: h.state.selection, rigSel: r2.selected ?? null };
          // lifted pose: stays lifted
          r2.setRoot({ y: r2.root.y + 0.3 });
          await h.ctx.setProfile(a.manualProfile({ sex: 'F', stature: 1500, mass: 50 }), { immediate: true });
          const r3 = h.state.rig;
          out.lifted = { low: r3.lowestY(), knee: r3.angles.knee_L[0] };
          out.disposedOld = r2 !== r3;
          return out;
        }""")
        print(json.dumps(r, indent=1))
        if abs(r["tall"]["low"]) > 0.003:
            finding(f"grounded figure not on the floor after a profile change: lowestY {r['tall']['low']}")
        if abs(r["tall"]["knee"] - 40) > 0.01:
            finding("pose not carried over on profile change")
        if r["tall"]["sel"] is None:
            finding("selection lost on profile change")
        if abs(r["lifted"]["low"] - 0.3) > 0.06:
            print("note: lifted pose after change: lowestY", r["lifted"]["low"])


def check_contrast2():
    for dark in (False, True):
        with session(dark=dark) as (page, logs, base):
            open_human(page, base)
            th = "dark" if dark else "light"
            page.evaluate("(()=>{const c=window.__human.ctx; c.notify('An info message', {level:'info', id:'i'}); c.notify('A warning message', {level:'warn', id:'w'}); c.notify('An error message', {level:'error', id:'e'}); c.setDisplay({labels:true, landmarks:true}); c.select({kind:'joint', id:'elbow_R'});})()")
            page.keyboard.press("?")
            page.wait_for_timeout(700)
            low = page.evaluate(CONTRAST_JS)
            print(th, [(x["text"], x["ratio"]) for x in low])
            for x in low:
                if x["cls"] != "hm-label hm-label-axis":
                    finding(f"[{th}] low contrast: {x}")
            page.screenshot(path=str(SHOTS / f"adv-notices-{th}.png"))

CHECKS = {k[6:]: v for k, v in list(globals().items()) if k.startswith("check_")}

if __name__ == "__main__":
    names = sys.argv[1:]
    if not names:
        print("checks:", ", ".join(CHECKS))
        sys.exit(0)
    if names == ["all"]:
        names = list(CHECKS)
    for n in names:
        t = time.time()
        n0 = len(FINDINGS)
        try:
            CHECKS[n]()
        except Exception as e:  # a crashing check is itself a result
            import traceback
            traceback.print_exc()
            finding(f"check {n} crashed: {type(e).__name__}: {e}")
        if len(FINDINGS) == n0:
            print(f"ok: {n} ({time.time() - t:.0f}s)")
    sys.exit(1 if FINDINGS else 0)
