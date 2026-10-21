"""Adversarial: drive the REAL Profile panel through every country/role/sex of index.json (UI selects), check each builds.
   python tests/human3d/profile-skeleton-panels.adversarial.combos.py [limit]"""
import sys, json, time
sys.path.insert(0, 'tests/human3d')
from shot import browser
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10**9
JS = r"""
async ({limit}) => {
  const H = window.__human, st = H.ctx.state;
  const sels = [...document.querySelectorAll('.hm-pf-view select')].slice(0, 3);
  const [sc, sr, ss] = sels;
  const idx = await (await fetch('api/v1/index.json')).json();
  const combos = idx.populations.map(p => [p.country_id, p.role_id, p.sex]).slice(0, limit);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fails = [], t0 = performance.now();
  const status = () => document.querySelector('.hm-pf-status');
  for (const [c, r, s] of combos) {
    const cs = document.querySelector('.hm-pf-view select'); // re-query: the view is redrawn
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    const q = () => [...document.querySelectorAll('.hm-pf-view select')].slice(0, 3);
    set(q()[0], c); set(q()[1], r); set(q()[2], s);
    const t = performance.now();
    let ok = false, why = '';
    while (performance.now() - t < 30000) {
      await sleep(100);
      const p = st.profile, b = st.body;
      if (p?.source?.country_id === c && p.source.role_id === r && p.source.sex === s && b && b.profileId === p.id && !st.busy) { ok = true; break; }
      const sx = status();
      if (sx && /error/.test(sx.className)) { why = 'status error: ' + sx.textContent; break; }
    }
    const sx = status();
    if (!ok) fails.push([c, r, s, why || 'timeout', sx?.textContent]);
    else {
      const b = st.body, q2 = q();
      if (q2[0].value !== c || q2[1].value !== r || q2[2].value !== s) fails.push([c, r, s, 'select drift', [q2[0].value, q2[1].value, q2[2].value].join('/')]);
      if (!Number.isFinite(b.stature) || !Number.isFinite(b.mass)) fails.push([c, r, s, 'NaN body']);
      if (st.notices.some(n => n.level === 'error')) fails.push([c, r, s, 'notice error', JSON.stringify(st.notices)]);
      const fitn = st.notices.find(n => n.id === 'fit'); if (fitn) fails.push([c, r, s, 'fit fallback', fitn.text]);
    }
  }
  return { n: combos.length, fails, secs: (performance.now() - t0) / 1000 };
}
"""
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select', timeout=30000)
    page.wait_for_timeout(1000)
    res = page.evaluate(JS, {"limit": limit}) if False else page.evaluate("(a)=>(" + JS + ")(a)", {"limit": limit})
    print(json.dumps(res, indent=1)[:6000])
    errs = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
    print(len(errs), 'console errors'); print('\n'.join(e[:250] for e in errs[:10]))
