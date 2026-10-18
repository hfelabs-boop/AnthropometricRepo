"""Adversarial smoke: open the real tab, shoot Profile and Skeleton panels in light/dark at desktop and phone width.
   python tests/human3d/profile-skeleton-panels.adversarial.smoke.py OUTDIR"""
import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]

def run(w, h, dark, tag, mobile=False):
    with browser(w, h, dark=dark, mobile=mobile) as (page, logs):
        page.goto(page.base + '/#/human?debug')
        page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
        page.wait_for_timeout(1500)
        # profile panel
        page.wait_for_selector('.hm-pf', timeout=20000)
        page.wait_for_timeout(1000)
        page.screenshot(path=f'{out}/{tag}-profile-top.png')
        page.screenshot(path=f'{out}/{tag}-profile-full.png', full_page=True)
        ov = page.evaluate("""() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})""")
        print(tag, 'scroll', ov)
        # skeleton tab
        page.click('[role=tab]:has-text("Skeleton")')
        page.wait_for_selector('.hm-sk', timeout=20000)
        page.wait_for_timeout(800)
        page.screenshot(path=f'{out}/{tag}-skeleton.png', full_page=True)
        ov = page.evaluate("""() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})""")
        print(tag, 'scroll sk', ov)
        for l in logs:
            if 'error' in l.lower() or 'pageerror' in l: print(tag, l[:300])

run(1280, 800, False, 'light-desk')
run(1280, 800, True, 'dark-desk')
run(390, 800, False, 'light-mob', True)
run(390, 800, True, 'dark-mob', True)
