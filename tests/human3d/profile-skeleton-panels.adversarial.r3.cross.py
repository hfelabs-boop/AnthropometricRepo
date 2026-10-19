"""Round 3: a population load in flight while the person switches to Manual / Import and builds something else (cross-source stale result)."""
import sys, time
sys.path.insert(0, 'tests/human3d')
from shot import browser
def st(page):
    return page.evaluate("()=>({pid: window.__human.state.profile?.id, src: window.__human.state.profile?.source?.kind, busy: window.__human.state.busy, status: document.querySelector('.hm-pf-status')?.textContent})")
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select', timeout=30000)
    held = []
    page.route("**/populations/france/**", lambda r: held.append(r))
    page.select_option('.hm-pf-view select >> nth=0', 'france')
    page.wait_for_timeout(500)
    print('held', len(held), st(page))
    # switch to manual and build
    page.click('.hm-pf-srcseg button:has-text("Manual")')
    page.fill('input[id^="hm-pf-mst"]', '1900')
    page.click('button:has-text("Build this body")')
    page.wait_for_function("window.__human.state.profile?.source?.kind==='manual' && !window.__human.state.busy", timeout=60000)
    print('manual built', st(page))
    for r in held: r.continue_()
    page.wait_for_timeout(4000)
    print('after france released', st(page))
    print([l for l in logs if l.startswith('[pageerror]')])
