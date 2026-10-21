"""Round 2: keyboard model of the joint tree and tab order of the Skeleton panel."""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
AE = "(()=>{const a=document.activeElement; return a? ((a.dataset&&a.dataset.node)||a.tagName+'.'+(a.className||'').toString().slice(0,25)+' '+(a.getAttribute('aria-label')||a.textContent||'').slice(0,25)) : null})()"
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.click('[role=tab]:has-text("Skeleton")'); page.wait_for_selector('.hm-sk-tree'); page.wait_for_timeout(400)
    stops = page.evaluate("[...document.querySelectorAll('.hm-sk-item')].filter(e=>e.tabIndex===0).map(e=>e.dataset.node)"); print('tab stops', stops)
    page.focus('.hm-sk-item[tabindex="0"]'); print('focus', page.evaluate(AE))
    for k in ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowLeft', 'End', 'Home', 'Enter', 'ArrowDown', 'Enter']:
        page.keyboard.press(k); page.wait_for_timeout(60)
        print(f'{k:11s} ->', page.evaluate(AE), '| sel', page.evaluate("window.__human.state.selection?.id"))
    # tab order after tree: where does Tab go?
    for i in range(3):
        page.keyboard.press('Tab'); print('Tab ->', page.evaluate(AE))
    page.keyboard.press('Shift+Tab'); page.keyboard.press('Shift+Tab'); print('Shift+Tab x2 ->', page.evaluate(AE))
    # search while an item is focused and hidden by the filter
    page.fill('input[aria-label="Search joints"]', 'wrist'); page.wait_for_timeout(100)
    print('visible after search wrist:', page.evaluate("[...document.querySelectorAll('.hm-sk-item')].filter(e=>!e.hidden).map(e=>e.dataset.node)"))
    stops = page.evaluate("[...document.querySelectorAll('.hm-sk-item')].filter(e=>e.tabIndex===0&&!e.hidden).length"); print('visible tab stops', stops)
    page.fill('input[aria-label="Search joints"]', '')
    page.keyboard.press('Escape')
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
