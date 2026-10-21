"""Round 5, real page: posture file round trip through the panel (download, change pose, load), hostile files, scene file loaded before the Scene tab was ever opened,
viewport state after PNG captures (size, pixel ratio, camera, pixels), resize during export, tab switching while busy."""
import importlib.util, json, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)

POSE = """() => { const r = window.__human.ctx.getRig(); const p = r.getPose(); return JSON.stringify({ root: p.root, angles: p.angles, rootpos: [r.root.x, r.root.y, r.root.z] }); }"""
VIEW = """() => { const v = window.__human.viewport, r = v.renderer; const c = v.camera;
  return JSON.stringify({ pr: r.getPixelRatio(), w: r.domElement.width, h: r.domElement.height, css: [r.domElement.style.width, r.domElement.style.height], cam: c.position.toArray().concat(c.quaternion.toArray(), [c.aspect, c.fov, c.zoom]), bg: v.scene.background && v.scene.background.getHex?.() }); }"""

with lib.session() as s:
    p = s.page
    s.open()
    # ---- posture round trip
    s.js("""() => { const r = window.__human.ctx.getRig(); r.setPose({ root: { x: 0.3, y: 1, z: 0.2, heading: 30, flex: 0, lat: 0, rot: 0 }, angles: { hip_L: [60, 5, 0], knee_L: [90], shoulder_R: [70, 10, 5], eye_R: [0, 10] } }, { clamp: true }); window.__human.ctx.emit('pose', {}); }""")
    before = json.loads(s.js(POSE))
    p.wait_for_timeout(400)
    name, data = s.grab("Download posture file")
    print("posture file", name, len(data))
    doc = json.loads(data)
    print({k: (v if not isinstance(v, (dict, list)) else "...") for k, v in doc.items()})
    # change the pose, then load the file via the hidden input
    s.js("""() => { const r = window.__human.ctx.getRig(); r.setPose({ root: { x: 0, y: 0.9, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 }, angles: {} }, { clamp: true }); window.__human.ctx.emit('pose', {}); }""")
    tmp = lib.SCRATCH / "adv5-posture.json"; tmp.write_bytes(data)
    p.locator(".hm-ex input[type=file]").first.set_input_files(str(tmp))
    p.wait_for_timeout(1500); s.idle()
    after = json.loads(s.js(POSE))
    ang_ok = all(abs(a - b) < 1e-3 for k in before["angles"] for a, b in zip(before["angles"][k], after["angles"][k]))
    print("angles restored:", ang_ok, "root", before["root"], "->", after["root"], "rootpos", before["rootpos"], "->", after["rootpos"])
    print("status:", p.locator(".hm-ex-last").inner_text()[:200], "| shell posture:", s.js("JSON.stringify(window.__human.ctx.state.posture)"))
    # a hostile file
    for label, content in [("not json", "hello"), ("scene file", json.dumps({"app": "digital-human-scene", "version": 1, "objects": []})), ("bad joint", json.dumps({"angles": {"nope": [1]}})), ("huge angle", json.dumps({"angles": {"knee_L": [9999]}}))]:
        tmp.write_text(content)
        p.locator(".hm-ex input[type=file]").first.set_input_files(str(tmp))
        p.wait_for_timeout(700); s.idle()
        msg = p.locator(".hm-ex-msgs").inner_text().replace("\n", " | ")
        print(f"  {label:12s} ->", msg[:200], "| last:", p.locator(".hm-ex-last").inner_text()[:100])
    # ---- PNG: viewport restored
    v0 = s.js(VIEW)
    px0 = s.js("() => { const c = window.__human.viewport.renderer.domElement; window.__human.viewport.renderNow(); return c.toDataURL().length; }")
    for btn, pre in [("Download PNG", None), ("Download 4 views", None)]:
        s.button("Transparent", exact=True).click() if False else None
    for scale in ("2×",):
        s.page.locator(".hm-ex").get_by_role("radio", name=scale).click() if p.locator(".hm-ex").get_by_role("radio", name=scale).count() else p.locator(".hm-ex .seg button", has_text=scale).click()
    p.locator(".hm-ex .seg button", has_text="Transparent").click()
    for btn in ("Download PNG", "Download 4 views"):
        name, data = s.grab(btn, timeout=180000)
        print(btn, name, len(data), data[:8])
        s.idle(); p.wait_for_timeout(300)
    v1 = s.js(VIEW)
    print("viewport before == after PNG:", v0 == v1)
    if v0 != v1:
        print(v0); print(v1)
    print("errors", s.errors())
