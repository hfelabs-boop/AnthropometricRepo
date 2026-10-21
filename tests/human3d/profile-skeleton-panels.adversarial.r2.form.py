"""Round 2: body form in the real (unpatched) tab: what happens, what the user is told."""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    page.evaluate("document.querySelectorAll('.hm-pf details.hm-section').forEach(d=>d.open=true)")
    page.click('.hm-pf-formseg button:has-text("Female")')
    page.wait_for_function("window.__human.ctx.getBody()?.profileId===window.__human.ctx.getProfile()?.id && !window.__human.state.busy", timeout=40000); page.wait_for_timeout(600)
    print(page.evaluate("({form: window.__human.ctx.getBody().form, pform: window.__human.ctx.getProfile().form, label: window.__human.ctx.getProfile().label, notices: window.__human.state.notices.map(n=>n.level+': '+n.text), status: document.querySelector('.hm-pf-status').textContent, card: document.querySelector('.hm-pf-facts').textContent, hint: document.querySelector('.hm-pf-formseg').parentElement.querySelector('p').textContent})"))
    page.screenshot(path=sys.argv[1] + '/form.png', clip={'x': 0, 'y': 200, 'width': 1280, 'height': 600})
