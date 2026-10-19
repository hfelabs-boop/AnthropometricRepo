"""Round 3: screenshots of the Profile and Skeleton panels in the real tab. python ...r3.shots.py OUTDIR tag w h [dark] [mobile]"""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out, tag, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]); dark = 'dark' in sys.argv; mobile = 'mobile' in sys.argv
with browser(w, h, dark=dark, mobile=mobile) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(800)
    page.screenshot(path=f'{out}/{tag}-profile-top.png')
    page.evaluate("document.querySelectorAll('.hm-pf details.hm-section').forEach(d=>d.open=true)")
    page.click('.hm-pf-dimbtn[data-dim="femur_length"]'); page.wait_for_timeout(400)
    page.screenshot(path=f'{out}/{tag}-profile-dim.png')
    page.screenshot(path=f'{out}/{tag}-profile-full.png', full_page=True)
    # skeleton tab
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()")
    page.wait_for_selector('.hm-sk .hm-sk-item', timeout=30000); page.wait_for_timeout(600)
    page.screenshot(path=f'{out}/{tag}-skel-top.png')
    page.evaluate("document.querySelectorAll('.hm-sk details.hm-section').forEach(d=>d.open=true)")
    page.evaluate("document.querySelector('[data-node=\"j:shoulder_L\"]').click()"); page.wait_for_timeout(500)
    page.screenshot(path=f'{out}/{tag}-skel-sel.png')
    page.screenshot(path=f'{out}/{tag}-skel-full.png', full_page=True)
    print(tag, [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')][:5])
