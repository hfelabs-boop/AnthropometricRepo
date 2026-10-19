"""Round 3: the fit fails and the shell shows the generic (synthetic) body: do the panels still render sensibly (no undefined / NaN / exceptions)?"""
import sys
from pathlib import Path
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
with browser(1280, 900) as (page, logs):
    t = Path('site/js/human/shell.js').read_text().replace("return m.fitBody(profile, { form: formOf(profile) });", "throw new Error('boom');")
    assert 'boom' in t
    page.route('**/js/human/shell.js', lambda r: r.fulfill(body=t, content_type='text/javascript'))
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf', timeout=30000); page.wait_for_timeout(1500)
    page.evaluate("document.querySelectorAll('.hm-pf details.hm-section').forEach(d=>d.open=true)")
    txt = page.inner_text('.hm-pf')
    print('body has dims:', page.evaluate("!!window.__human.ctx.getBody().dims"), 'report:', page.evaluate("!!window.__human.ctx.getBody().report"), 'form', page.evaluate("window.__human.ctx.getBody().form"))
    for w in ['undefined', 'NaN', 'null', 'Infinity', '[object']:
        if w in txt: print('TEXT HAS', w, [l for l in txt.split('\n') if w in l][:3])
    print('status:', page.inner_text('.hm-pf-status')); print('card:', page.inner_text('.hm-pf-card').replace('\n', ' | '))
    print('notices', page.evaluate("window.__human.state.notices.map(n=>n.level+': '+n.text.slice(0,120))"))
    page.screenshot(path=f'{out}/r3-synth-profile.png')
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()")
    page.wait_for_selector('.hm-sk .hm-sk-item'); page.evaluate("document.querySelectorAll('.hm-sk details.hm-section').forEach(d=>d.open=true)")
    page.evaluate("window.__human.ctx.select({kind:'joint', id:'shoulder_L'})"); page.wait_for_timeout(500)
    txt2 = page.inner_text('.hm-sk') + page.inner_text('#hm-inspector-body')
    for w in ['undefined', 'NaN', 'null', 'Infinity', '[object']:
        if w in txt2: print('SK TEXT HAS', w, [l for l in txt2.split('\n') if w in l][:3])
    print('summary', page.inner_text('.hm-sk-summary'))
    print('seg:', page.inner_text('.hm-sk-seg-box').replace('\n', ' | '))
    page.screenshot(path=f'{out}/r3-synth-skel.png')
    # try CSV
    try:
        with page.expect_download(timeout=5000) as d: page.click('button:has-text("Download CSV")')
        print('csv ok', len(open(d.value.path()).read()))
    except Exception as e: print('csv failed', str(e)[:100], page.inner_text('.hm-sk-lms')[:0])
    print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')][:6])
