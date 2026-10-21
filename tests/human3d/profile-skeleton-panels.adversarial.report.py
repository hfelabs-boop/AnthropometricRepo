import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
def run(dark, w, h, tag, mobile=False):
  with browser(w, h, dark=dark, mobile=mobile) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn')
    # open fit report
    page.click('summary:has-text("Fit report")')
    page.wait_for_timeout(300)
    rows = page.evaluate("[...document.querySelectorAll('.hm-pf-rep .hm-pf-rrow')].map(r=>[r.dataset.id,r.dataset.status,r.querySelector('.hm-pf-rnums').innerText.replace(/\\n/g,' ')])")
    print(tag, 'report rows', len(rows), 'summary', page.inner_text('.hm-pf-repsum'))
    for r in rows[:4]: print('  ', r)
    bad = [r for r in rows if 'NaN' in r[2] or 'undefined' in r[2] or 'Infinity' in r[2]]
    print('  bad text rows', bad)
    page.click('button:has-text("Recompute in current pose")'); page.wait_for_timeout(500)
    rows0 = page.evaluate("[...document.querySelectorAll('.hm-pf-rep .hm-pf-rrow')].map(r=>[r.dataset.id,r.querySelector('.hm-pf-rnums').innerText.replace(/\\n/g,' ')])")
    print('  neutral-pose recompute sample:', rows0[:3])
    # seated pose
    page.evaluate("""()=>{const r=window.__human.state.rig; r.setPose({root:{y:0.55}, angles:{hip_L:[90,0,0],hip_R:[90,0,0],knee_L:[90],knee_R:[90]}})}""")
    page.wait_for_timeout(300)
    page.click('button:has-text("Recompute in current pose")'); page.wait_for_timeout(500)
    rows1 = page.evaluate("[...document.querySelectorAll('.hm-pf-rep .hm-pf-rrow')].map(r=>[r.dataset.id,r.querySelector('.hm-pf-rnums').innerText.replace(/\\n/g,' ')])")
    print('  seated sample:', [r for r in rows1 if 'sitting' in r[0] or 'buttock' in r[0]][:3])
    bad = [r for r in rows1 if 'NaN' in r[1] or 'undefined' in r[1]]
    print('  bad seated', bad)
    # pose changes after recompute: stale?
    page.evaluate("""()=>{const r=window.__human.state.rig; r.setPose({root:{y:0}, angles:{}})}""")
    page.wait_for_timeout(300)
    rows2 = page.evaluate("[...document.querySelectorAll('.hm-pf-rep .hm-pf-rrow')].map(r=>[r.dataset.id,r.querySelector('.hm-pf-rnums').innerText.replace(/\\n/g,' ')])")
    print('  after pose change columns identical to before (stale):', rows2 == rows1, 'has pose col', 'in this pose' in rows2[0][1])
    # screenshot panel (unclip)
    page.evaluate("""()=>{for (let e=document.querySelector('.hm-pf'); e && e!==document.body; e=e.parentElement){ const cs=getComputedStyle(e); if (/(auto|scroll|hidden)/.test(cs.overflowY)||cs.maxHeight!=='none'){ e.style.maxHeight='none'; e.style.overflow='visible'; e.style.height='auto'; } } }""")
    page.locator('.hm-pf-repsum').scroll_into_view_if_needed()
    el = page.locator('.hm-pf-rep').first
    page.screenshot(path=f'{out}/{tag}-report.png', clip={**el.bounding_box(), 'height': min(900, el.bounding_box()['height'])} if False else None, full_page=False)
    # dimension detail open
    page.click('.hm-pf-dimbtn[data-dim="upper_arm_length"]'); page.wait_for_timeout(300)
    page.locator('.hm-pf-dimbtn[data-dim="upper_arm_length"]').scroll_into_view_if_needed()
    page.screenshot(path=f'{out}/{tag}-dimdetail.png')
    print('  scroll width', page.evaluate("document.documentElement.scrollWidth"), 'client', page.evaluate("document.documentElement.clientWidth"))
    print('  errors', [l[:150] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
run(False, 1280, 800, 'L-desk')
run(True, 390, 800, 'D-mob', True)
