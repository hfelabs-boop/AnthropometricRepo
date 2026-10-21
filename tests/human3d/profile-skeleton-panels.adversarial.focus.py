import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn')
    ae = lambda: page.evaluate("(()=>{const e=document.activeElement; return e.tagName+' '+(e.className||'')+' '+(e.dataset.focusKey||'')+' '+(e.textContent||'').slice(0,20)})()")
    def settle(): page.wait_for_timeout(400); page.wait_for_function("!window.__human.state.busy", timeout=60000); page.wait_for_timeout(150)
    page.focus('.hm-pf-dimbtn[data-dim="hand_length"]'); page.keyboard.press('Enter'); page.wait_for_timeout(300); print('after open', ae())
    page.focus('.hm-pf-dimdetail input.hm-pf-edit'); page.keyboard.press('Control+a'); page.keyboard.type('210'); page.keyboard.press('Enter'); settle(); print('after apply (Enter)', ae())
    page.focus('.hm-pf-dimdetail button:has-text("Revert")'); page.keyboard.press('Enter'); settle(); print('after Revert', ae())
    # edit again then Revert all
    page.focus('.hm-pf-dimdetail input.hm-pf-edit'); page.keyboard.press('Control+a'); page.keyboard.type('215'); page.keyboard.press('Enter'); settle()
    page.focus('button:has-text("Revert all edits")'); page.keyboard.press('Enter'); settle(); print('after Revert all', ae())
    # Apply button click
    page.focus('.hm-pf-dimdetail input.hm-pf-edit'); page.keyboard.press('Control+a'); page.keyboard.type('212')
    page.focus('.hm-pf-dimdetail button:has-text("Apply")'); page.keyboard.press('Enter'); settle(); print('after Apply button', ae())
    # source switching keyboard
    page.focus('.hm-pf-srcseg button:has-text("Manual")'); page.keyboard.press('Enter'); page.wait_for_timeout(300); print('after Manual', ae())
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
