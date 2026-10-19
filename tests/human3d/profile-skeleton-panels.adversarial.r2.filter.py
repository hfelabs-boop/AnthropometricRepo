"""Round 2: filtered tree / landmark list / dimension list really hide rows ([hidden] vs display rules), empty-state messages."""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    VIS = "(sel)=>[...document.querySelectorAll(sel)].filter(e=>e.getClientRects().length>0 && getComputedStyle(e).display!=='none').length"
    page.fill('input[aria-label="Search dimensions"]', 'thigh'); page.wait_for_timeout(200)
    print('dims rows for thigh', page.evaluate(VIS, '.hm-pf-dimbtn'), page.inner_text('.hm-pf-dimsum'))
    page.fill('input[aria-label="Search dimensions"]', 'qqqq'); page.wait_for_timeout(200)
    print('dims none:', page.inner_text('.hm-pf-dims')[:60], '|', page.inner_text('.hm-pf-dimsum'))
    page.fill('input[aria-label="Search dimensions"]', ''); 
    page.click('.hm-pf-fchip[data-filter="estimated"]'); page.wait_for_timeout(200); print('estimated chip rows', page.evaluate(VIS, '.hm-pf-dimbtn'), '| disabled edited chip', page.evaluate("document.querySelector('.hm-pf-fchip[data-filter=edited]').disabled"))
    page.click('.hm-pf-fchip[data-filter="all"]')
    page.click('[role=tab]:has-text("Skeleton")'); page.wait_for_selector('.hm-sk'); page.wait_for_timeout(400)
    page.fill('input[aria-label="Search joints"]', 'wrist'); page.wait_for_timeout(200)
    print('tree visible', page.evaluate(VIS, '.hm-sk-item'), 'for wrist')
    page.fill('input[aria-label="Search joints"]', 'zzz'); print('tree visible', page.evaluate(VIS, '.hm-sk-item'), 'empty msg visible', page.evaluate(VIS, '.hm-sk-none'))
    page.fill('input[aria-label="Search joints"]', '')
    page.click('summary:has-text("Landmarks")'); page.wait_for_timeout(300)
    print('landmarks visible', page.evaluate(VIS, '.hm-sk-lm'))
    page.fill('input[aria-label="Search landmarks"]', 'acromion'); page.wait_for_timeout(200); print('acromion ->', page.evaluate(VIS, '.hm-sk-lm'), page.evaluate("[...document.querySelectorAll('.hm-sk-lm')].filter(e=>e.getClientRects().length).slice(0,3).map(e=>e.innerText.replace(/\\n/g,' | '))"))
    page.fill('input[aria-label="Search landmarks"]', 'zzzz'); page.wait_for_timeout(200); print('none ->', page.evaluate(VIS, '.hm-sk-lm'), page.evaluate(VIS, '.hm-sk-lms ~ p[role=status], .hm-sk-lmwrap ~ p[role=status]'))
    page.fill('input[aria-label="Search landmarks"]', '<b>x</b> "quote" \\ [ ( *')  # regex-ish junk
    page.wait_for_timeout(200); print('junk query ok', page.evaluate(VIS, '.hm-sk-lm'))
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
