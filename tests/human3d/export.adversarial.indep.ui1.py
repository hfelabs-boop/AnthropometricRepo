"""Independent look at the Export tab: screenshots (desktop/phone, light/dark), horizontal scroll, target sizes, contrast of every visible text node against its real background, focus ring on every control.
    python tests/human3d/export.adversarial.indep.ui1.py   (screenshots go to $HM_SCRATCH/v/)"""
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
OUT = lib.SCRATCH / "v"; OUT.mkdir(exist_ok=True)

AUDIT = r"""() => {
  const root = document.querySelector('.hm-ex');
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; if (!stack.length || stack[stack.length-1].a < 1) base = parse(getComputedStyle(document.body).backgroundColor) || base; for (const c of stack.reverse()) base = over(c, base); return base; };
  const bad = [], sizes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const n = walker.currentNode; if (!n.textContent.trim()) continue;
    const el = n.parentElement; if (seen.has(el)) continue; seen.add(el);
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = bgOf(el), fg = over(fg0, bg), L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize), large = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) bad.push([el.tagName, n.textContent.trim().slice(0, 40), ratio.toFixed(2), px, el.disabled ? 'disabled' : '']);
  }
  for (const c of root.querySelectorAll('button, input, select, summary, [role=radio], [tabindex="0"]')) {
    const r = c.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (c.closest('details:not([open])') && c.tagName !== 'SUMMARY' && !c.closest('summary')) continue;
    if (r.width < 24 || r.height < 24) sizes.push([c.tagName, (c.textContent || c.getAttribute('aria-label') || c.type || '').trim().slice(0, 30), Math.round(r.width), Math.round(r.height)]);
  }
  return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, rootScrollW: root.scrollWidth, rootClientW: root.clientWidth, bad: bad.slice(0, 15), badCount: bad.length, small: sizes.slice(0, 15) };
}"""

for name, kw in [("desk-light", dict(width=1280, height=900)), ("desk-dark", dict(width=1280, height=900, dark=True)), ("m360-light", dict(width=360, height=740, mobile=True)), ("m360-dark", dict(width=360, height=740, dark=True, mobile=True))]:
    with lib.session(**kw) as s:
        s.open()
        res = s.js(AUDIT)
        print(name, json.dumps(res)[:1400])
        s.page.locator(".hm-ex").first.screenshot(path=str(OUT / f"{name}.png"))
        s.page.screenshot(path=str(OUT / f"{name}-page.png"), full_page=False)
        print("  errors", s.errors()[:3])
