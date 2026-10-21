import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
OLD = "return m.fitBody(profile, { form: formOf(profile) });"
NEW = "return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });"
def patch(route):
    t = open('site/js/human/shell.js').read(); route.fulfill(body=t.replace(OLD, NEW), content_type='text/javascript')
for patched in (False, True):
  with browser(1280, 800) as (page, logs):
    if patched: page.route("**/js/human/shell.js", patch)
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn')
    page.click('summary:has-text("Body form")')
    def S(): return page.evaluate("()=>({label:window.__human.state.profile.label, form:window.__human.state.profile.form, bform:window.__human.state.body.form, mass:window.__human.state.body.mass, pressed:[...document.querySelectorAll('.hm-pf-formseg button')].filter(b=>b.getAttribute('aria-pressed')==='true'||b.classList.contains('is-active')||b.getAttribute('aria-checked')==='true').map(b=>b.textContent), notes:window.__human.state.profile.notes.map(n=>n.slice(0,50)), notices:window.__human.state.notices.map(n=>n.text.slice(0,70)), status:document.querySelector('.hm-pf-status').textContent.slice(0,90)})")
    def settle(): page.wait_for_timeout(400); page.wait_for_function("!window.__human.state.busy", timeout=60000); page.wait_for_timeout(100)
    print('patched', patched, 'start', S())
    for f in ['Female', 'Neutral', 'Male', 'Auto']:
        page.click(f'.hm-pf-formseg button:has-text("{f}")'); settle(); print(f, S())
    # form persists across population change?
    page.click('.hm-pf-formseg button:has-text("Female")'); settle()
    page.click('button:has-text("P95")'); settle(); print('P95 after Female:', S())
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
