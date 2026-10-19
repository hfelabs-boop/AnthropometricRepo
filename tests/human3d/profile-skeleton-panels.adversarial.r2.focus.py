"""Round 2: where does the keyboard focus go after the individual list / pager / dims / source switch redraw?"""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
AE = "(()=>{const a=document.activeElement; return a? (a.tagName+'.'+(a.className||'').toString().slice(0,30)+'#'+(a.id||'')+' '+(a.textContent||'').slice(0,30)) : null})()"
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    page.click('.hm-pf-srcseg button:has-text("Individual")')
    page.wait_for_selector('.hm-pf-view select', timeout=90000); page.wait_for_timeout(800)
    page.click('.hm-pf-view button:has-text("From a list")'); page.wait_for_selector('.hm-pf-person', timeout=30000)
    page.focus('button:has-text("Next")'); page.keyboard.press('Enter'); page.wait_for_timeout(1200)
    print('after Next (keyboard):', page.evaluate(AE))
    page.focus('.hm-pf-person >> nth=2'); page.keyboard.press('Enter'); page.wait_for_timeout(300)
    page.wait_for_function("!window.__human.state.busy", timeout=40000); page.wait_for_timeout(800)
    print('after choosing a person (keyboard):', page.evaluate(AE))
    page.focus('#' + page.evaluate("document.querySelector('.hm-pf-view select').id")); 
    page.keyboard.press('ArrowDown'); page.wait_for_timeout(1500)
    print('after changing the survey select (ArrowDown):', page.evaluate(AE))
    page.click('.hm-pf-view button:has-text("Closest match")'); page.wait_for_timeout(300)
    page.focus('button:has-text("Find the closest person")'); page.keyboard.press('Enter'); page.wait_for_timeout(1500)
    page.wait_for_function("!window.__human.state.busy", timeout=40000)
    print('after Find closest (keyboard):', page.evaluate(AE))
    # segmented control keyboard: focus retained after click?
    page.focus('.hm-pf-view .seg button >> nth=1'); page.keyboard.press('Enter'); page.wait_for_timeout(500)
    print('after seg button Enter:', page.evaluate(AE))
    # dims: open a row by keyboard, apply by keyboard
    page.click('.hm-pf-srcseg button:has-text("Population")'); page.wait_for_timeout(500)
    page.focus('.hm-pf-dimbtn[data-dim="hand_length"]'); page.keyboard.press('Enter'); page.wait_for_timeout(300)
    print('after opening row:', page.evaluate(AE))
    page.keyboard.press('Tab'); print('tab ->', page.evaluate(AE)); page.keyboard.press('Tab'); print('tab ->', page.evaluate(AE))
    page.keyboard.press('Tab'); print('tab ->', page.evaluate(AE))
    page.keyboard.press('Tab'); print('tab ->', page.evaluate(AE))
    # select a dimension then Escape?
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
