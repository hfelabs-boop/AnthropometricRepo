"""Round 3: accessibility, overflow and visual audit of the Scene and Measure panels (populated), light/dark, 1280x800 and 390x800 / 360x740.
python3 tests/human3d/sandbox.adversarial.r3a11y.py OUTDIR"""
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SETUP = """async () => {
  const sb = await %s, ms = await %s;
  sb.applyTemplate('cockpit');
  const o = [...sb.objects.values()];
  sb.add('crate', { position: [0.8, 0, 0.6], params: { mass: 25 } });
  sb.select(o[0].id);
  const lm = (id) => ({ kind: 'landmark', id });
  ms.addDistance(lm('eye_mid'), { kind: 'object', id: o.find(x => x.type==='hud_panel').id, anchor: 'glass_centre' });
  ms.addHeight(lm('vertex'));
  ms.addAngle({ kind: 'joint', id: 'shoulder_L' }, { kind: 'joint', id: 'elbow_L' }, { kind: 'joint', id: 'wrist_L' });
  ms.select(ms.items[0].id);
}""" % (lib.SB, lib.MS)
AUDIT = r"""(sel) => {
  const root = document.querySelector(sel), res = {};
  const vis = (e) => !!(e.offsetParent || e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
  const name = (e) => { const a = e.getAttribute('aria-label'); if (a) return a; const lb = e.getAttribute('aria-labelledby'); if (lb) return lb.split(' ').map(i => document.getElementById(i)?.textContent || '').join(' ');
    if (e.id) { const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l) return l.textContent; } const p = e.closest('label'); if (p) return p.textContent; return (e.title || e.textContent || e.placeholder || ''); };
  res.noName = [...root.querySelectorAll('input,select,textarea,button,[role=button],[role=tab],[role=option],[role=switch],[role=slider]')].filter(vis).filter(e => !name(e).trim()).map(e => e.outerHTML.slice(0, 160)).slice(0, 10);
  const ids = {}; for (const e of document.querySelectorAll('[id]')) ids[e.id] = (ids[e.id] || 0) + 1; res.dupIds = Object.entries(ids).filter(([k, v]) => v > 1).map(([k]) => k).slice(0, 10);
  res.badRefs = [...document.querySelectorAll('[aria-controls],[aria-labelledby],[aria-describedby],[list]')].flatMap(e => ['aria-controls','aria-labelledby','aria-describedby','list'].flatMap(a => (e.getAttribute(a) || '').split(' ').filter(Boolean).filter(i => !document.getElementById(i)).map(i => a + '=' + i))).slice(0, 10);
  res.small = [...root.querySelectorAll('button,input:not([type=range]),select,[role=button]')].filter(vis).filter(e => { const r = e.getBoundingClientRect(); return r.height < 24 || r.width < 24; }).map(e => (e.getAttribute('aria-label') || e.textContent || e.className).toString().trim().slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)).slice(0, 12);
  const pr = root.getBoundingClientRect();
  res.overflow = [...root.querySelectorAll('*')].filter(vis).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > pr.right + 1 || r.left < pr.left - 1); }).map(e => e.tagName + '.' + e.className.toString().slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().right - pr.right)).slice(0, 10);
  res.doc = [document.documentElement.scrollWidth, document.documentElement.clientWidth];
  // text contrast: walk visible text nodes' parents, compute WCAG ratio against the first opaque background up the tree
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (e) => { let acc = null; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { if (c.a >= 0.99) return acc ? mix(acc, c) : c; acc = acc ? mix(acc, c) : c; } } return acc || { r: 255, g: 255, b: 255, a: 1 }; };
  const mix = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bad = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim(); if (!t) continue; const e = n.parentElement; if (!vis(e) || e.closest('.sr-only')) continue;
    const cs = getComputedStyle(e), fg = parse(cs.color); if (!fg) continue; const bg = bgOf(e); const f2 = fg.a < 1 ? mix(fg, bg) : fg;
    const L1 = lum(f2), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700, large = px >= 24 || (px >= 18.66 && bold);
    if (ratio < (large ? 3 : 4.5) && (parseFloat(cs.opacity) || 1) > 0.5) bad.push(`${ratio.toFixed(2)} "${t.slice(0, 30)}" ${e.className.toString().slice(0, 30)} ${px}px`);
  }
  res.contrast = [...new Set(bad)].slice(0, 12);
  return res;
}"""
cfgs = [(1280, 800, False), (1280, 800, True), (390, 800, False), (390, 800, True), (360, 740, False)]
for (w, h, dark) in cfgs:
    tag = f"{w}-{'dark' if dark else 'light'}"
    with browser(w, h, dark, mobile=(w < 500)) as (page, logs):
        lib.open_human(page, "scene")
        page.evaluate(SETUP)
        page.wait_for_timeout(1500)
        print(tag, "SCENE", json.dumps(page.evaluate(AUDIT, ".hm-sc"))[:1600])
        page.screenshot(path=str(OUT / f"scene-{tag}.png"))
        page.click("#hm-tab-measure"); page.wait_for_timeout(900)
        print(tag, "MEASURE", json.dumps(page.evaluate(AUDIT, ".hm-ms"))[:1600])
        page.screenshot(path=str(OUT / f"measure-{tag}.png"))
        print(tag, "errors", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
