"""Round 5: the profile changes while a file is being built: is the file name (computed when the build ends) consistent with the content (profile and rig taken when the click was handled)?"""
import importlib.util, json, struct
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
def glb_json(data):
    n = struct.unpack("<I", data[12:16])[0]; return json.loads(data[20:20 + n])
with lib.session() as s:
    p = s.page
    s.open()
    for btn, kind in [("Download JSON", "json"), ("Download GLB", "glb"), ("Download BVH", "bvh"), ("Download OBJ", "obj")]:
        # restore the first profile
        s.js("""async () => { const a = await import('/js/human/anthro.js'); window.__human.ctx.setProfile(a.manualProfile({ sex: 'M', stature: 1900, statureUnit: 'mm', mass: 95, massUnit: 'kg' })); }""")
        p.wait_for_function("() => Math.abs(window.__human.ctx.getRig().body.stature - 1.9) < 0.01 && !window.__human.state.busy", timeout=60000); p.wait_for_timeout(500)
        with p.expect_download(timeout=90000) as info:
            s.button(btn).click(no_wait_after=True)
            p.wait_for_timeout(20)
            s.js("""async () => { const a = await import('/js/human/anthro.js'); window.__human.ctx.setProfile(a.manualProfile({ sex: 'F', stature: 1500, statureUnit: 'mm', mass: 50, massUnit: 'kg' })); }""")
        d = info.value; data = Path(d.path()).read_bytes()
        if kind == "json": doc = json.loads(data); content = f"profile {doc['profile']['label']!r} stature {doc['body']['stature_mm']}"
        elif kind == "glb": content = "asset.extras.profile " + json.dumps(glb_json(data)["asset"]["extras"]["profile"])
        elif kind == "bvh": content = "root offset/first frame y " + data.decode().split("Frame Time")[1].split("\n")[1].split()[1]
        else: txt = data.decode(); content = [l for l in txt.split("\n")[:6] if l.startswith("# Profile")][0]
        print(f"{btn:14s} file name: {d.suggested_filename}\n               content: {content}")
        s.idle(); p.wait_for_timeout(3000)
    print("errors", s.errors()[:3])
