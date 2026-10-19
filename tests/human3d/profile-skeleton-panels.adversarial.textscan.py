import sys, json, re
sys.path.insert(0, 'tests/human3d')
from shot import browser
BAD = re.compile(r'NaN|undefined|\[object|Infinity|\bnull\b|-0\.0\b|−0\b')
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select')
    idx = page.evaluate("fetch('api/v1/index.json').then(r=>r.json()).then(j=>j.populations.map(p=>[p.country_id,p.role_id,p.sex,p.measures]))")
    idx.sort(key=lambda x: x[3])
    picks = idx[:6] + idx[len(idx)//2:len(idx)//2+3] + idx[-4:]
    for c, r, s, n in picks:
        page.evaluate("""([c,r,s])=>{const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}))}; const q=()=>[...document.querySelectorAll('.hm-pf-view select')]; set(q()[0],c); set(q()[1],r); set(q()[2],s);}""", [c, r, s])
        try: page.wait_for_function("([c,r,s])=>{const st=window.__human.state;return st.profile?.source?.country_id===c&&st.profile.source.role_id===r&&st.profile.source.sex===s&&st.body?.profileId===st.profile.id&&!st.busy}", arg=[c, r, s], timeout=40000)
        except Exception: print('TIMEOUT', c, r, s, n); continue
        page.wait_for_timeout(200)
        # open report section and all dims; expand all rows? scan text
        page.evaluate("document.querySelectorAll('.hm-pf details').forEach(d=>d.open=true)")
        txt = page.evaluate("document.querySelector('.hm-pf').innerText")
        hits = sorted(set(m.group(0) for m in BAD.finditer(txt)))
        ctx_ = [txt[max(0, m.start()-50):m.end()+30].replace('\n', ' ') for m in BAD.finditer(txt)][:3]
        # open a few detail rows
        for d in ['hip_height', 'stature', 'knee_height', 'ring_chest']:
            page.evaluate("(d)=>document.querySelector(`.hm-pf-dimbtn[data-dim=\"${d}\"]`)?.click()", d)
            t2 = page.evaluate("document.querySelector('.hm-pf-dimdetail')?.innerText ?? ''")
            for m in BAD.finditer(t2): ctx_.append('DETAIL ' + d + ': ' + t2[max(0, m.start()-40):m.end()+20].replace('\n', ' '))
        sk = None
        print(f'{c[:20]}/{r}/{s} n={n}:', hits, ctx_[:4], '| est', re.search(r'Estimated: \d+ of \d+', txt).group(0))
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
