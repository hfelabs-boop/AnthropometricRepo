import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
OLD = "return m.fitBody(profile, { form: formOf(profile) });"
NEW = "return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });"
def patch(route):
    t = open('site/js/human/shell.js').read(); route.fulfill(body=t.replace(OLD, NEW), content_type='text/javascript')
with browser(1280, 800) as (page, logs):
    page.route("**/js/human/shell.js", patch)
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn')
    def settle():
        page.wait_for_timeout(300); page.wait_for_function("!window.__human.state.busy", timeout=60000); page.wait_for_timeout(100)
    def dim(i): return page.evaluate("(i)=>window.__human.state.body.dims.find(d=>d.id===i).value*1000", i)
    def edit(i, v):
        if page.locator(f'.hm-pf-dimbtn[data-dim="{i}"][aria-expanded=true]').count() == 0:
            page.evaluate("(d)=>document.querySelector(`.hm-pf-dimbtn[data-dim=\"${d}\"]`).click()", i)
        inp = page.locator('.hm-pf-dimdetail input.hm-pf-edit'); inp.fill(''); inp.press_sequentially(v); inp.press('Enter'); page.wait_for_timeout(500)
        try: settle()
        except Exception: print('busy')
        return page.evaluate("()=>({msg:document.querySelector('.hm-pf-dimdetail .hm-pf-msg')?.textContent, status:document.querySelector('.hm-pf-status').textContent.slice(0,140), n:window.__human.state.notices.map(n=>n.text.slice(0,80))})")
    for units in ['mm', 'cm', 'in']:
        page.evaluate(f"window.__human.ctx.setUnits('{units}')"); page.wait_for_timeout(300)
        for i, v in [('hand_length', {'mm': '205', 'cm': '20.5', 'in': '8'}[units]), ('upper_arm_length', {'mm': '300', 'cm': '30', 'in': '12'}[units])]:
            r = edit(i, v); print(units, i, v, '->', round(dim(i), 2), r['msg'], '|', r['status'][:90])
    page.evaluate("window.__human.ctx.setUnits('mm')"); page.wait_for_timeout(300)
    for i, v in [('hand_length', '1'), ('hand_length', '-5'), ('hand_length', '99999'), ('hand_length', '1e400'), ('hand_length', 'abc'), ('hand_length', '0'), ('hand_length', '2000'), ('upper_arm_length', '0'), ('upper_arm_length', '-3'), ('upper_arm_length', '6000'), ('upper_arm_length', '10'), ('upper_arm_length', '2000'), ('stature', '500'), ('stature', '3500'), ('mass', '5'), ('mass', '1000'), ('ring_waist', '50'), ('ring_waist', '4000'), ('shoulder_protraction', '-20'), ('shoulder_protraction', '20')]:
        before = dim(i) if i != 'mass' else page.evaluate("window.__human.state.body.mass")
        r = edit(i, v); after = dim(i) if i != 'mass' else page.evaluate("window.__human.state.body.mass")
        print(i, v, f'{before:.1f} -> {after:.1f}', '| msg:', r['msg'], '| status:', r['status'][:100], '| notices', r['n'])
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
