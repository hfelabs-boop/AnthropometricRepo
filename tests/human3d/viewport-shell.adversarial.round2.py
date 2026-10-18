"""Second round of adversarial checks for the Digital human shell (reuses the helpers of viewport-shell.adversarial.py).
    python3 tests/human3d/viewport-shell.adversarial.round2.py <check> ...
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("vsa", HERE / "viewport-shell.adversarial.py")
vsa = importlib.util.module_from_spec(spec)
sys.modules["vsa"] = vsa
spec.loader.exec_module(vsa)
session, open_human, finding, SHOTS = vsa.session, vsa.open_human, vsa.finding, vsa.SHOTS


def check_mobile_dark():
    with session(390, 800, True, mobile=True) as (page, logs, base):
        open_human(page, base)
        page.screenshot(path=str(SHOTS / "r2-mobile-dark.png"))
        page.screenshot(path=str(SHOTS / "r2-mobile-dark-full.png"), full_page=True)
        print(page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]"))


def check_desktop_shots():
    for dark in (False, True):
        with session(1280, 800, dark) as (page, logs, base):
            open_human(page, base)
            page.evaluate("window.__human.ctx.setDisplay({skeleton:true, joints:true, labels:true})")
            page.wait_for_timeout(1200)
            page.screenshot(path=str(SHOTS / f"r2-desktop-{'dark' if dark else 'light'}.png"))



PROBE_RAF = """(() => { if (window.__raf) return; window.__raf = {n: 0}; const r = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => { window.__raf.n++; return r(f); }; })()"""
bad_logs = vsa.bad_logs
ALLOW404 = ("404 (File not found)",)  # body.js (skin) is not written yet: reported separately


def check_hashspam():
    """Flip between #/human and other tabs while the 3D module is still loading, then settle; no leaks, one canvas, rendered."""
    for settle in ("#/human", "#/sql"):
        with session(init=PROBE_RAF) as (page, logs, base):
            page.goto(base + "/#/catalog")
            page.wait_for_timeout(300)
            for i in range(14):
                page.evaluate(f"location.hash = '{['#/human', '#/about'][i % 2]}'")
                page.wait_for_timeout(15 * (i % 4))
            page.evaluate(f"location.hash = '{settle}'")
            page.wait_for_timeout(5000)
            n = page.evaluate("document.querySelectorAll('.hm-canvas').length")
            st = page.evaluate("document.querySelector('.hm-root')?.dataset.hmState")
            act = page.evaluate("window.__human?.viewport.active")
            print(settle, "canvases", n, "state", st, "active", act)
            if settle == "#/human":
                if n != 1 or st != "ready" or act is not True:
                    finding(f"hash spam ending on #/human: canvases={n} state={st} active={act}")
                page.wait_for_timeout(500)
                a = page.evaluate("window.__raf.n"); page.wait_for_timeout(1500); b = page.evaluate("window.__raf.n")
                if b - a > 3:
                    finding(f"rAF keeps running while idle after hash spam ({b - a} in 1.5 s)")
                nz = page.evaluate("(() => { const c = document.querySelector('.hm-canvas'); return [c.width, c.height]; })()")
                print("canvas", nz)
            else:
                if act is not False:
                    finding(f"hash spam ending on #/sql: viewport still active ({act})")
                a = page.evaluate("window.__raf.n"); page.wait_for_timeout(1500); b = page.evaluate("window.__raf.n")
                if b - a > 3:
                    finding(f"rAF runs while the tab is hidden after hash spam ({b - a} in 1.5 s)")
            errs = bad_logs(logs, allow=ALLOW404)
            if errs:
                finding(f"hash spam console problems: {errs[:4]}")


def check_stale_pointer():
    """Pointer pressed on the canvas, tab hidden, pointer released elsewhere: later clicks must still select / drag must not stick."""
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({joints:true})")
        page.wait_for_timeout(600)
        box = page.locator(".hm-canvas").bounding_box()
        page.mouse.move(box["x"] + 50, box["y"] + 50)
        page.mouse.down()
        page.evaluate("location.hash = '#/about'")
        page.wait_for_timeout(300)
        page.mouse.up()
        page.evaluate("location.hash = '#/human'")
        page.wait_for_timeout(1000)
        p = page.evaluate("(() => { const v = window.__human.viewport; const r = window.__human.state.rig; const pt = r.jointWorld('knee_L'); const s = v.project(pt); const b = v.canvas.getBoundingClientRect(); return {x: b.left + s.x, y: b.top + s.y, vis: s.visible}; })()")
        page.mouse.click(p["x"], p["y"])
        page.wait_for_timeout(300)
        sel = page.evaluate("window.__human.state.selection")
        print("selection after stale pointer", sel)
        if not sel or sel.get("id") != "knee_L":
            finding(f"after pointer-down, tab hide and pointer-up elsewhere, a click on a joint does not select it (selection={sel}); stale pointer id in viewport.js pointers set / down state")


def check_focus_rings():
    with session() as (page, logs, base):
        open_human(page, base)
        res = []
        for _ in range(40):
            page.keyboard.press("Tab")
            info = page.evaluate("""() => { const e = document.activeElement; if (!e || !e.closest('#view-human')) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
              return {t: e.tagName + '.' + (e.className.baseVal ?? e.className) + ' ' + (e.getAttribute('aria-label') || e.title || e.textContent || '').trim().slice(0, 24), ow: cs.outlineWidth, os: cs.outlineStyle, oc: cs.outlineColor, sh: cs.boxShadow !== 'none', vis: r.width > 0 && r.height > 0}; }""")
            if info:
                res.append(info)
        seen = set()
        for i in res:
            if i["t"] in seen:
                continue
            seen.add(i["t"])
            ok = (i["os"] != "none" and i["ow"] not in ("0px",)) or i["sh"]
            print("focus", i["t"], i["os"], i["ow"], i["oc"], "ok" if ok else "NO RING")
            if not ok:
                finding(f"no visible focus indicator on {i['t']}")
        page.screenshot(path=str(SHOTS / "r2-focus.png"))


def check_typing_keys():
    """Shortcuts must not fire while typing in input / textarea / select / contenteditable (also inside the panels)."""
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("""() => { const b = document.querySelector('.hm-panel-body:not([hidden]) .hm-panel-host') || document.querySelector('.hm-panel-body');
          b.insertAdjacentHTML('beforeend', '<input id="t-in" type="text"><input id="t-num" type="number"><input id="t-rng" type="range"><textarea id="t-ta"></textarea><select id="t-sel"><option>a</option><option>b</option></select><div id="t-ce" contenteditable="true">x</div>'); }""")
        before = page.evaluate("window.__human.viewport.getView().azimuth")
        for sel in ("#t-in", "#t-ta", "#t-ce", "#t-num", "#t-rng", "#t-sel"):
            page.focus(sel)
            for k in ("1", "2", "3", "4", "5", "6", "f", "F", "?", "Escape"):
                page.keyboard.press(k)
            helpOpen = page.evaluate("!document.querySelector('.hm-help').hidden")
            az = page.evaluate("window.__human.viewport.getView().azimuth")
            if helpOpen or abs(az - before) > 0.01:
                finding(f"shortcut keys captured while focus is in {sel} (help open={helpOpen}, azimuth {before}->{az})")
                page.evaluate("document.querySelector('.hm-help').hidden = true")
                before = az
        # modifier combos must pass
        page.focus(".hm-canvas")
        a0 = page.evaluate("window.__human.viewport.getView().azimuth")
        page.keyboard.press("Control+1"); page.keyboard.press("Alt+2"); page.keyboard.press("Meta+3")
        page.wait_for_timeout(700)
        a1 = page.evaluate("window.__human.viewport.getView().azimuth")
        if abs(a1 - a0) > 0.01:
            finding("1..6 shortcuts fire with Ctrl/Alt/Meta held (they would steal browser shortcuts such as Ctrl+1 tab switching)")
        # the shortcut must not scroll the page or otherwise leak; typed '?' with Shift
        page.keyboard.press("Shift+/")
        print("help after Shift+/:", page.evaluate("!document.querySelector('.hm-help').hidden"))


def check_extreme_profiles():
    """Absurd profiles must neither hang nor leak NaN into the camera / rig."""
    with session() as (page, logs, base):
        open_human(page, base)
        cases = {
            "huge": {"stature": 1e9, "mass": 80}, "tiny": {"stature": 1, "mass": 1}, "neg": {"stature": -1700, "mass": -5},
            "nan": {"stature": "NaN", "mass": "abc"}, "inf": {"stature": 1e308, "mass": 1e308}, "zero": {"stature": 0, "mass": 0}, "neginf": {"stature": -1e308, "mass": 80}, "kid": {"stature": 900, "mass": 12}, "giant": {"stature": 2500, "mass": 400}, "nomass": {"stature": 1750, "mass": 1},
        }
        for name, m in cases.items():
            r = page.evaluate("""async ([name, m]) => {
              const num = (x) => (x === 'NaN' ? NaN : x === 'abc' ? NaN : x);
              const prof = {id: 'x-' + name, label: 'Extreme ' + name, sex: 'M', source: {kind: 'manual'}, notes: [], measures: {
                stature: {value: num(m.stature), unit: 'mm', status: 'edited'}, mass: {value: num(m.mass), unit: 'kg', status: 'edited'}, ...(m.extra || {})}};
              const res = await window.__human.ctx.setProfile(prof, {immediate: true});
              const s = window.__human.state, v = window.__human.viewport;
              const bad = [];
              s.rig?.group.traverse(o => { const e = o.matrixWorld.elements; if (e.some(x => !Number.isFinite(x))) bad.push(o.name); });
              const cam = v.camera.position.toArray().concat(v.controls.target.toArray());
              return {ok: res.ok, fb: res.fallback, rig: !!s.rig, badNodes: bad.length, camFinite: cam.every(Number.isFinite), notices: s.notices.map(n => n.level + ':' + n.text.slice(0, 90)), busy: s.busy, h: s.rig && (s.rig.lowestY ? s.rig.lowestY() : null)};
            }""", [name, m])
            print(name, r)
            if r.get("threw"):
                continue
            if not r["rig"] or r["badNodes"] or not r["camFinite"] or r["busy"]:
                finding(f"extreme profile {name}: {r}")
        page.wait_for_timeout(500)
        # the view must still render something non-empty
        page.screenshot(path=str(SHOTS / "r2-extreme.png"))
        errs = bad_logs(logs, allow=ALLOW404)
        if errs:
            finding(f"extreme profiles console problems: {errs[:4]}")


def check_resize_extremes():
    with session() as (page, logs, base):
        open_human(page, base)
        for (w, h_) in [(320, 480), (2400, 500), (1280, 800), (700, 300), (1000, 1400), (1280, 800)]:
            page.set_viewport_size({"width": w, "height": h_})
            page.wait_for_timeout(500)
            r = page.evaluate("""(() => { const c = document.querySelector('.hm-canvas'); const b = c.getBoundingClientRect(); const v = window.__human.viewport; return {w: c.width, h: c.height, cw: Math.round(b.width), ch: Math.round(b.height), aspect: v.camera.aspect, sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth}; })()""")
            print((w, h_), r)
            if r["sw"] > r["vw"] + 1:
                finding(f"horizontal scroll at {w}x{h_}: {r['sw']} > {r['vw']}")
            if abs(r["aspect"] - r["cw"] / max(r["ch"], 1)) > 0.02:
                finding(f"camera aspect {r['aspect']} does not match canvas {r['cw']}x{r['ch']} at {w}x{h_}")
            if r["w"] > 4096 or r["h"] > 4096:
                finding(f"canvas backing store too large {r['w']}x{r['h']}")
        errs = bad_logs(logs, allow=ALLOW404)
        if errs:
            finding(f"resize console problems: {errs[:4]}")


def check_theme_hidden():
    """Toggle the site theme while the tab is hidden: on return the canvas, grid and labels must use the new colours."""
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("location.hash = '#/about'")
        page.wait_for_timeout(300)
        page.click("#theme-toggle")
        page.wait_for_timeout(200)
        page.evaluate("location.hash = '#/human'")
        page.wait_for_timeout(1500)
        r = page.evaluate("({dark: window.__human.viewport.theme.dark, bg: '#' + window.__human.viewport.scene.background.getHexString(), docDark: document.documentElement.dataset.theme, st: window.__human.state.theme})")
        print(r)
        px = page.evaluate("""(() => { const v = window.__human.viewport; v.renderNow(); const c = document.createElement('canvas'); c.width = v.canvas.width; c.height = v.canvas.height; const g = c.getContext('2d'); g.drawImage(v.canvas, 0, 0); return Array.from(g.getImageData(5, 5, 1, 1).data); })()""")
        print("corner", px)
        want_dark = r["docDark"] == "dark"
        if r["dark"] != want_dark or r["st"]["dark"] != want_dark:
            finding(f"theme toggled while hidden is not applied on return: {r}")
        lum = sum(px[:3]) / 3
        if want_dark and lum > 90 or (not want_dark and lum < 150):
            finding(f"canvas corner colour {px} does not match theme (dark={want_dark})")


def check_labels_bounded():
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({joints:true, labels:true, landmarks:true, skeleton:true})")
        page.wait_for_timeout(800)
        box = page.locator(".hm-canvas").bounding_box()
        counts = []
        for i in range(8):
            page.mouse.move(box["x"] + 200, box["y"] + 200)
            page.mouse.down()
            page.mouse.move(box["x"] + 200 + 40 * (i % 3), box["y"] + 200 + 30 * (i % 2), steps=3)
            page.mouse.up()
            page.wait_for_timeout(700)
            counts.append(page.evaluate("document.querySelectorAll('.hm-overlay .hm-label').length"))
        print("label elements", counts)
        if max(counts) > 160:
            finding(f"too many label elements in the DOM: {counts}")
        ov = page.evaluate("""(() => { const els = [...document.querySelectorAll('.hm-overlay .hm-label')]; const o = document.querySelector('.hm-overlay').getBoundingClientRect(); return els.filter(e => { const r = e.getBoundingClientRect(); return r.right > o.right + 1 || r.bottom > o.bottom + 1; }).length; })()""")
        print("labels outside overlay", ov)
        page.screenshot(path=str(SHOTS / "r2-labels.png"))


def check_idle_cpu():
    """Long idle with everything on: the render loop must be quiet (no continuous rAF, no timers)."""
    with session(init=PROBE_RAF) as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({joints:true, labels:true, landmarks:true, skeleton:true, com:true})")
        page.wait_for_timeout(1500)
        a = page.evaluate("window.__raf.n"); page.wait_for_timeout(3000); b = page.evaluate("window.__raf.n")
        print("idle rAF in 3 s", b - a)
        if b - a > 3:
            finding(f"idle rAF loop: {b - a} frames in 3 s with all displays on")
        # hover without buttons must not loop
        box = page.locator(".hm-canvas").bounding_box()
        page.mouse.move(box["x"] + 300, box["y"] + 200)
        page.wait_for_timeout(300)
        a = page.evaluate("window.__raf.n"); page.wait_for_timeout(2000); b = page.evaluate("window.__raf.n")
        if b - a > 3:
            finding(f"rAF loop continues while hovering ({b - a} in 2 s)")



def check_gizmo():
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("""(async () => {
          const THREE = await import('three');
          const v = window.__human.viewport;
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial({color: 0xff8800}));
          m.position.set(0.8, 0.3, 0.3); m.name = 'box'; v.add(m);
          window.__ev = [];
          for (const t of ['gizmo-start', 'gizmo-change', 'gizmo-end', 'click', 'click-unhandled']) v.on(t, () => window.__ev.push(t));
          v.setView('front', {animate: false});
          v.attachGizmo(m, {mode: 'translate', space: 'world', snap: null});
          window.__box = m;
        })()""")
        page.wait_for_timeout(800)
        page.screenshot(path=str(SHOTS / "r2-gizmo.png"))
        # find the screen position of the +X arrow tip: project box centre + (0.18,0,0)
        pos = page.evaluate("""(() => { const v = window.__human.viewport; const b = v.canvas.getBoundingClientRect(); const m = window.__box;
          const a = v.project(m.position), t = v.project({x: m.position.x + 0.25 * 0.8 * 0.6, y: m.position.y, z: m.position.z});
          return {cx: b.left + a.x, cy: b.top + a.y, tx: b.left + t.x, ty: b.top + t.y}; })()""")
        print(pos)
        cam0 = page.evaluate("window.__human.viewport.camera.position.toArray()")
        x0 = page.evaluate("window.__box.position.x"); p0 = page.evaluate("window.__box.position.toArray()")
        page.mouse.move(pos["tx"], pos["ty"]); page.wait_for_timeout(100)
        page.mouse.down(); page.mouse.move(pos["tx"] + 40, pos["ty"], steps=5); page.mouse.move(pos["tx"] + 80, pos["ty"], steps=5); page.mouse.up()
        page.wait_for_timeout(500)
        ev = page.evaluate("window.__ev")
        x1 = page.evaluate("window.__box.position.x"); print("pos", p0, page.evaluate("window.__box.position.toArray()"))
        cam1 = page.evaluate("window.__human.viewport.camera.position.toArray()")
        print("events", ev, "box x", x0, "->", x1, "cam moved", [round(a - b, 4) for a, b in zip(cam1, cam0)])
        if x1 == x0:
            finding("gizmo drag did not move the attached object (could not hit the arrow; check manually)")
        else:
            if max(abs(a - b) for a, b in zip(cam1, cam0)) > 1e-3:
                finding("camera orbited while dragging the transform gizmo")
            if "click" in ev or "click-unhandled" in ev:
                finding(f"gizmo drag emitted a viewport click: {ev}")
            if "gizmo-start" not in ev or "gizmo-end" not in ev or "gizmo-change" not in ev:
                finding(f"missing gizmo events: {ev}")
        # orbit works again afterwards
        b = page.locator(".hm-canvas").bounding_box()
        page.mouse.move(b["x"] + 100, b["y"] + 100); page.mouse.down(); page.mouse.move(b["x"] + 180, b["y"] + 100, steps=5); page.mouse.up()
        page.wait_for_timeout(500)
        cam2 = page.evaluate("window.__human.viewport.camera.position.toArray()")
        if max(abs(a - b) for a, b in zip(cam2, cam1)) < 1e-3:
            finding("orbit stays disabled after a gizmo drag")
        # hide tab while attached, return, detach: no errors; helper removed from scene
        page.evaluate("location.hash = '#/about'"); page.wait_for_timeout(300); page.evaluate("location.hash = '#/human'"); page.wait_for_timeout(500)
        page.evaluate("window.__human.viewport.detachGizmo()")
        n = page.evaluate("window.__human.viewport.scene.children.filter(c => c.type === 'TransformControlsRoot' || c.isTransformControlsRoot).length")
        print("gizmo helper children after detach (hidden)", n)
        # attach again then change quality -> pipeline rebuild; then dispose: must not throw
        page.evaluate("window.__human.viewport.attachGizmo(window.__box, {mode: 'rotate'})")
        page.evaluate("window.__human.ctx.setQuality(window.__human.state.quality === 'low' ? 'high' : 'low')")
        page.wait_for_timeout(2000)
        errs = bad_logs(logs, allow=ALLOW404)
        if errs:
            finding(f"gizmo console problems: {errs[:4]}")


def check_slow_click():
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({joints:true})")
        page.wait_for_timeout(600)
        p = page.evaluate("(() => { const v = window.__human.viewport; const r = window.__human.state.rig; const s = v.project(r.jointWorld('knee_L')); const b = v.canvas.getBoundingClientRect(); return {x: b.left + s.x, y: b.top + s.y}; })()")
        for hold in (100, 350, 600, 1200):
            page.evaluate("window.__human.ctx.select(null)")
            page.mouse.move(p["x"], p["y"]); page.mouse.down(); page.wait_for_timeout(hold); page.mouse.up(); page.wait_for_timeout(200)
            sel = page.evaluate("window.__human.state.selection")
            print("hold", hold, "->", sel)
        # touch tap with hold 600 ms handled the same way: report



def check_console_flow():
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({joints:true, labels:true, landmarks:true, skeleton:true, com:true, xray:true})")
        page.wait_for_timeout(500)
        b = page.locator(".hm-canvas").bounding_box()
        page.mouse.move(b["x"] + 300, b["y"] + 200); page.mouse.down(); page.mouse.move(b["x"] + 360, b["y"] + 230, steps=4); page.mouse.up()
        page.mouse.wheel(0, -400); page.wait_for_timeout(200); page.mouse.wheel(0, 3000); page.wait_for_timeout(300)
        for sel in ['button[data-view="top"]', 'button[data-view="back"]', 'button[data-value="in"]', 'button[data-value="cm"]', '.hm-quality', '.hm-quality', 'button[aria-label="Keyboard and mouse help"]']:
            page.click(sel); page.wait_for_timeout(400)
        page.keyboard.press("Escape")
        page.click("#theme-toggle"); page.wait_for_timeout(400); page.click("#theme-toggle"); page.wait_for_timeout(400)
        for t in ["Posture", "Scene", "Measure", "Skeleton", "Analysis", "Export", "Profile"]:
            page.click(f'.hm-tab:has-text("{t}")'); page.wait_for_timeout(250)
        page.evaluate("location.hash='#/explore'"); page.wait_for_timeout(500); page.evaluate("location.hash='#/human'"); page.wait_for_timeout(800)
        page.reload(); page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=90000)
        page.wait_for_timeout(1000)
        for l in logs:
            print(l[:300])



def check_aria():
    with session() as (page, logs, base):
        open_human(page, base)
        r = page.evaluate("""() => {
          const root = document.getElementById('view-human'); const out = [];
          const ids = new Map(); root.querySelectorAll('[id]').forEach(e => ids.set(e.id, (ids.get(e.id) || 0) + 1));
          for (const [k, n] of ids) if (n > 1) out.push('duplicate id ' + k);
          if (document.querySelectorAll('[id]').length !== new Set([...document.querySelectorAll('[id]')].map(e => e.id)).size) out.push('duplicate ids in document');
          root.querySelectorAll('[aria-controls],[aria-labelledby],[aria-describedby]').forEach(e => { for (const a of ['aria-controls', 'aria-labelledby', 'aria-describedby']) { const v = e.getAttribute(a); if (v) v.split(' ').forEach(i => { if (!document.getElementById(i)) out.push(a + ' -> missing #' + i + ' on ' + e.tagName + '.' + e.className); }); } });
          root.querySelectorAll('button, [role=button], a, input, select, textarea, canvas[tabindex]').forEach(e => {
            const name = (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent || e.textContent || e.title || (e.labels && e.labels[0]?.textContent) || '').trim();
            if (!name) out.push('no accessible name: ' + e.outerHTML.slice(0, 90)); });
          // focusable elements inside hidden containers
          root.querySelectorAll('[hidden] button, [hidden] input, [hidden] a, [hidden] [tabindex]').forEach(e => { if (e.tabIndex >= 0 && e.getClientRects().length) out.push('visible focusable in hidden: ' + e.outerHTML.slice(0, 60)); });
          // tab pattern
          const tabs = [...root.querySelectorAll('[role=tab]')]; const sel = tabs.filter(t => t.getAttribute('aria-selected') === 'true');
          if (sel.length !== 1) out.push('selected tabs: ' + sel.length);
          if (tabs.filter(t => t.tabIndex === 0).length !== 1) out.push('tab stops in tablist != 1');
          const heads = [...root.querySelectorAll('h1,h2,h3')].map(h => h.tagName + ':' + h.textContent.trim().slice(0, 20));
          return {out, heads, lang: document.documentElement.lang, landmarks: [...root.querySelectorAll('aside,[role=region],section,nav,main')].map(e => e.tagName + ':' + (e.getAttribute('aria-label') || ''))};
        }""")
        print(r)
        for o in r["out"]:
            finding("a11y: " + o)



def check_anim_promise():
    with session() as (page, logs, base):
        open_human(page, base)
        page.wait_for_timeout(1200)
        r = page.evaluate("""async () => {
          const v = window.__human.viewport; const res = {};
          const settled = (p) => { let s = 'pending'; p.then(() => { s = 'resolved'; }); return () => s; };
          // 1. superseded by a second move
          const p1 = v.setView('back'); const s1 = settled(p1); const p2 = v.setView('left'); const s2 = settled(p2);
          await new Promise(r => setTimeout(r, 1500));
          res.superseded = [s1(), s2()];
          // 2. cancelled by a wheel / pointerdown on the canvas
          const p3 = v.setView('right'); const s3 = settled(p3);
          await new Promise(r => setTimeout(r, 30));
          v.canvas.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 9, button: 0, clientX: 100, clientY: 100, bubbles: true}));
          v.canvas.dispatchEvent(new PointerEvent('pointerup', {pointerId: 9, button: 0, clientX: 100, clientY: 100, bubbles: true}));
          await new Promise(r => setTimeout(r, 1500));
          res.cancelled = s3();
          // 3. frame() superseded
          const p4 = window.__human.ctx.frame(true); const s4 = settled(p4); const p5 = v.setView('front'); await new Promise(r => setTimeout(r, 1500));
          res.frame = s4();
          return res;
        }""")
        print(r)
        if "pending" in r["superseded"] or r["cancelled"] == "pending" or r["frame"] == "pending":
            finding(f"the promise returned by setView()/frame() never settles when the camera animation is superseded or cancelled by the user (viewport.js cancelAnim drops `resolve`): {r}")



def check_loss_hidden():
    with session(init=PROBE_RAF) as (page, logs, base):
        open_human(page, base)
        page.wait_for_timeout(800)
        # lose the context while hidden, restore while hidden, then show: must render again, one message at most
        page.evaluate("location.hash = '#/about'"); page.wait_for_timeout(400)
        page.evaluate("""(() => { const gl = window.__human.viewport.renderer.getContext(); window.__lose = gl.getExtension('WEBGL_lose_context'); window.__lose.loseContext(); })()""")
        page.wait_for_timeout(500)
        msgs = page.evaluate("document.querySelectorAll('.hm-vp-msg').length")
        page.evaluate("window.__lose.restoreContext()")
        page.wait_for_timeout(1200)
        page.set_viewport_size({"width": 1000, "height": 700})
        page.wait_for_timeout(300)
        page.evaluate("location.hash = '#/human'"); page.wait_for_timeout(1500)
        r = page.evaluate("""(() => { const v = window.__human.viewport; v.renderNow(); const c = document.createElement('canvas'); c.width = v.canvas.width; c.height = v.canvas.height; const g = c.getContext('2d'); g.drawImage(v.canvas, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 37) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
          const b = v.canvas.getBoundingClientRect();
          return {msgs: document.querySelectorAll('.hm-vp-msg').length, colors: seen.size, lost: v.info().lost, cw: v.canvas.width, bw: Math.round(b.width), active: v.active}; })()""")
        print("msgs while hidden+lost", msgs, r)
        if r["msgs"] or r["colors"] < 6 or r["lost"]:
            finding(f"after context loss+restore while the tab was hidden the view did not recover: {r}")
        if abs(r["cw"] - r["bw"]) > 2:
            finding(f"canvas not resized after window resize while hidden: backing {r['cw']} vs css {r['bw']}")
        a = page.evaluate("window.__raf.n"); page.wait_for_timeout(1500); b = page.evaluate("window.__raf.n")
        if b - a > 3:
            finding(f"rAF loop running after loss/restore ({b - a})")
        # loss while visible + Retry button + second loss
        page.evaluate("window.__lose.loseContext()")
        page.wait_for_timeout(500)
        page.click(".hm-vp-msg button"); page.wait_for_timeout(1500)
        r = page.evaluate("({msgs: document.querySelectorAll('.hm-vp-msg').length, canv: document.querySelectorAll('.hm-canvas').length, lost: window.__human.viewport.info().lost})")
        print("after retry", r)
        if r["msgs"] or r["canv"] != 1:
            finding(f"after Retry: {r}")
        # rig still follows interactions after rebuild: click on joint selects
        page.evaluate("window.__human.ctx.setDisplay({joints:true})"); page.wait_for_timeout(500)
        p = page.evaluate("(() => { const v = window.__human.viewport; const r = window.__human.state.rig; const s = v.project(r.jointWorld('knee_L')); const b = v.canvas.getBoundingClientRect(); return {x: b.left + s.x, y: b.top + s.y}; })()")
        page.mouse.click(p["x"], p["y"]); page.wait_for_timeout(300)
        sel = page.evaluate("window.__human.state.selection")
        if not sel:
            finding("after Retry (renderer rebuilt) clicking a joint no longer selects it")
        errs = bad_logs(logs, allow=ALLOW404 + ("context", "Context"))
        if errs:
            finding(f"loss_hidden console problems: {errs[:4]}")
        print([l[:150] for l in logs])



def check_notice_shots():
    for (w, dark) in [(1280, False), (390, True), (1280, True)]:
        with session(w, 800, dark, mobile=(w < 500)) as (page, logs, base):
            page.route("**/api/v1/**", lambda r: r.abort())
            open_human(page, base)
            page.evaluate("window.__human.ctx.notify('A test error message that is long enough to wrap onto a second line in the narrow layout, to see how it looks.', {level: 'error', id: 'x'}); window.__human.ctx.notify('Info message', {level: 'info', id: 'y'})")
            page.wait_for_timeout(600)
            page.screenshot(path=str(SHOTS / f"r2-notices-{w}-{'dark' if dark else 'light'}.png"))



def check_longtasks():
    with session(init="window.__lt=[]; new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({type:'longtask', buffered:true})") as (page, logs, base):
        open_human(page, base)
        page.wait_for_timeout(1500)
        print("long tasks during load", page.evaluate("window.__lt"))
        t = page.evaluate("""async () => { const s = window.__human.state; const t0 = performance.now(); const p = JSON.parse(JSON.stringify(s.profile)); p.id += 'x'; await window.__human.ctx.setProfile(p, {immediate: true}); return performance.now() - t0; }""")
        print("rebuild ms", t)
        page.wait_for_timeout(800)
        print("long tasks total", page.evaluate("window.__lt"))
        worst = max([d for _, d in page.evaluate("window.__lt")] or [0])
        if worst > 400:
            finding(f"main-thread long task of {worst} ms during load/rebuild (SwiftShader, so a real GPU is faster): {page.evaluate('window.__lt')}")



def check_module_retry():
    for what in ("**/vendor/three/three.module.min.js", "**/js/human/viewport.js", "**/human.css", "**/js/human/rig.js"):
        with session() as (page, logs, base):
            state = {"block": True}
            def handler(route, *_):
                if state["block"]:
                    route.abort()
                else:
                    route.continue_()
            page.route(what, handler)
            page.goto(base + "/#/human")
            page.wait_for_timeout(4500)
            txt = page.evaluate("document.getElementById('view-human').innerText.slice(0, 160)")
            print(what, "->", txt.replace("\n", " | "))
            state["block"] = False
            btn = page.query_selector("#view-human button.btn")
            if btn:
                btn.click()
                try:
                    page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=40000)
                    print("  retry worked")
                except Exception:
                    st = page.evaluate("document.getElementById('view-human').innerText.slice(0, 200)")
                    finding(f"after blocking {what} and unblocking it, Retry does not recover the Digital human tab: {st!r}")
            else:
                st = page.evaluate("document.querySelector('.hm-root')?.dataset.hmState")
                print("  no retry button; state", st, "(css block is tolerated)" if "css" in what else "")
                if "css" not in what and "rig" not in what:
                    finding(f"blocking {what}: no error message with Retry shown (state={st})")



def check_tooltip_edge():
    with session() as (page, logs, base):
        open_human(page, base)
        page.evaluate("window.__human.ctx.setDisplay({joints:true})")
        page.evaluate("(() => { const v = window.__human.viewport; const t = v.controls.target.clone(); t.x -= 0.55; const d = v.camera.position.clone().sub(v.controls.target); v.moveTo(t.clone().add(d), t, {animate:false}); })()")
        page.wait_for_timeout(700)
        p = page.evaluate("(() => { const v = window.__human.viewport; const r = window.__human.state.rig; const s = v.project(r.jointWorld('shoulder_L')); const b = v.canvas.getBoundingClientRect(); return {x: b.left + s.x, y: b.top + s.y, right: b.right}; })()")
        page.mouse.move(p["x"] - 30, p["y"]); page.mouse.move(p["x"], p["y"], steps=4)
        page.wait_for_timeout(500)
        r = page.evaluate("(() => { const t = document.querySelector('.hm-tip'); const o = document.querySelector('.hm-overlay').getBoundingClientRect(); const b = t.getBoundingClientRect(); return {hidden: t.hidden, text: t.textContent, tr: b.right, or: o.right, tl: b.left}; })()")
        print(p, r)
        page.screenshot(path=str(SHOTS / "r2-tip-edge.png"), clip={"x": p["x"] - 150, "y": p["y"] - 60, "width": 300, "height": 120})
        if not r["hidden"] and r["tr"] > r["or"] + 1:
            finding(f"hover tooltip is clipped at the right edge of the view (tip right {r['tr']:.0f} > view right {r['or']:.0f}); index.js setHover has no edge flip")



def check_key_zoom():
    with session() as (page, logs, base):
        open_human(page, base)
        page.wait_for_timeout(1500)
        page.focus(".hm-canvas")
        d0 = page.evaluate("window.__human.viewport.getView().distance")
        changed = {}
        for k in ("+", "=", "-", "_", "PageUp", "PageDown", "Home", "End", "Shift+ArrowUp", "Control+ArrowUp", "ArrowUp", "ArrowLeft"):
            page.evaluate("window.__human.viewport.moveTo(window.__human.viewport.getView().position, window.__human.viewport.getView().target, {animate:false})")
            a = page.evaluate("(() => { const v = window.__human.viewport.getView(); return [v.distance, v.azimuth, v.polar, ...v.target.toArray()]; })()")
            page.keyboard.press(k); page.wait_for_timeout(500)
            b = page.evaluate("(() => { const v = window.__human.viewport.getView(); return [v.distance, v.azimuth, v.polar, ...v.target.toArray()]; })()")
            changed[k] = [round(y - x, 3) for x, y in zip(a, b)]
        print(changed)
        if not any(abs(changed[k][0]) > 1e-3 for k in changed):
            finding("no keyboard way to zoom the 3D view: with the canvas focused, + - PageUp PageDown and arrow combinations leave the camera distance unchanged; only wheel/pinch zoom (WCAG 2.1.1, DESIGN 3.6 keyboard-operable). Fit (F) and the view presets are the only distance changes")



def check_breakpoints():
    with session(1280, 800) as (page, logs, base):
        open_human(page, base)
        for w in (1920, 1400, 1261, 1260, 1259, 1100, 960, 901, 900, 899, 768, 600, 599, 480, 360, 320):
            page.set_viewport_size({"width": w, "height": 800})
            page.wait_for_timeout(350)
            r = page.evaluate("""() => { const vw = document.documentElement.clientWidth; const out = [];
              document.querySelectorAll('#view-human button, #view-human input, #view-human summary').forEach(e => { const r = e.getBoundingClientRect(); if (!r.width) return;
                let sc = false; for (let p = e.parentElement; p && p.id !== 'view-human'; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { sc = true; break; } }
                if (!sc && (r.right > vw + 1 || r.left < -1)) out.push(e.className + ':' + e.textContent.trim().slice(0, 14) + ':' + Math.round(r.left) + '-' + Math.round(r.right)); });
              const ov = [...document.querySelectorAll('#view-human *')].filter(e => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible' && e.clientWidth > 0 && !e.closest('svg') && getComputedStyle(e).display !== 'inline').slice(0, 4).map(e => e.className + ' ' + e.scrollWidth + '>' + e.clientWidth);
              const c = document.querySelector('.hm-canvas').getBoundingClientRect();
              return {sw: document.documentElement.scrollWidth, vw, out, ov, canvas: [Math.round(c.width), Math.round(c.height)]}; }""")
            print(w, r)
            if r["sw"] > r["vw"] + 1:
                finding(f"horizontal scroll at width {w}: {r['sw']} > {r['vw']}")
            if r["out"]:
                finding(f"controls outside the viewport at width {w}: {r['out']}")
            if r["canvas"][0] < 200 or r["canvas"][1] < 200:
                finding(f"3D view too small at width {w}: {r['canvas']}")



def check_nav_during_load():
    import time as _t
    with session() as (page, logs, base):
        def slow(route, *_):
            _t.sleep(0)  # handled below with a timer
            page.wait_for_timeout(6000)
            route.continue_()
        page.route("**/vendor/three/three.module.min.js", slow)
        page.goto(base + "/#/catalog")
        page.wait_for_timeout(500)
        page.evaluate("location.hash = '#/human'")
        page.wait_for_timeout(700)
        t0 = _t.time()
        page.click('a.tab[data-view="about"]')
        shown_at = None
        for i in range(40):
            vis = page.evaluate("[!document.getElementById('view-about').hidden, !document.getElementById('view-human').hidden]")
            if vis[0]:
                shown_at = _t.time() - t0
                break
            page.wait_for_timeout(250)
        print("About became visible after (s):", shown_at)
        if shown_at is None or shown_at > 2:
            finding(f"leaving #/human while the 3D module is still loading blocks navigation: the About view only appeared after {shown_at} s (app.js route() awaits the pending init promise before hiding the view; a stalled 3D download would freeze every tab switch)")


if __name__ == "__main__":
    for n in sys.argv[1:]:
        globals()["check_" + n]()
    sys.exit(1 if vsa.FINDINGS else 0)
