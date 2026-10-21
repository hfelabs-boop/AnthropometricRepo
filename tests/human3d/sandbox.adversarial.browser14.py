import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const s = await {SB}; s.add('monitor', {{ position: [0.2, 0.74, 1.2] }}); }}")
    page.click("#hm-tab-measure"); page.wait_for_timeout(600)
    page.select_option(".hm-ms select[aria-label='What to measure']", "view"); page.wait_for_timeout(300)
    eye = page.locator(".hm-ms input[list]").first
    print("default eye text:", eye.input_value())
    eye.fill("Joint · Left elbow"); 
    page.evaluate(f"async () => {{ const s = await {SB}; s.add('box'); }}"); page.wait_for_timeout(500)
    print("eye text after a scene change:", eye.input_value())
    # distance form: typed text kept?
    page.select_option(".hm-ms select[aria-label='What to measure']", "distance"); page.wait_for_timeout(300)
    f = page.locator(".hm-ms input[list]").first; f.fill("vertex"); 
    page.evaluate(f"async () => {{ const s = await {SB}; s.add('box'); }}"); page.wait_for_timeout(500)
    print("distance field after scene change:", f.input_value())
    f.fill("Top of the head"); print("matchPoint('Top of the head') ->", page.evaluate(f"async () => {{ const m = await {MS}; return m.matchPoint('vertex') ? m.matchPoint('vertex').text : null; }}"))
    # add a distance via form with partial typed text 'eye' (ambiguous?)
    for q in ["eye", "elbow", "screen", "head", "hand", "palm"]:
        print(q, "->", page.evaluate(f"async (q) => {{ const m = await {MS}; const r = m.matchPoint(q); return r ? r.text : null; }}", q))
    # tool + hint
    page.click(".hm-ms button:has-text('Height')"); 
    c = lib.client(page, [0.2, 0.9, 1.2]); page.mouse.click(c["x"], c["y"]); page.wait_for_timeout(500)
    print("hint after completing a height measurement:", page.locator(".hm-ms-hint").inner_text(), "| pending", page.evaluate(f"async () => (await {MS}).pending.length"), "items", page.evaluate(f"async () => (await {MS}).items.length"))
