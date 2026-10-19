"""Round 2: edits in cm / in, decimal commas, junk text, Enter key, no-op Apply. (patched shell so overrides work)"""
import sys, json
from pathlib import Path
sys.path.insert(0, 'tests/human3d')
from shot import browser
t = Path('site/js/human/shell.js').read_text().replace("return m.fitBody(profile, { form: formOf(profile) });", "return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });")
with browser(1280, 900) as (page, logs):
    page.route('**/js/human/shell.js', lambda r: r.fulfill(body=t, content_type='text/javascript'))
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    def settle():
        page.wait_for_timeout(200); page.wait_for_function("()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}", timeout=40000); page.wait_for_timeout(200)
    def dim(d): return page.evaluate("(d)=>window.__human.ctx.getBody().dims.find(x=>x.id===d).value", d)
    def edit(d, text, apply='button'):
        page.evaluate("(d)=>{const b=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`); if(b.getAttribute('aria-expanded')!=='true') b.click()}", d)
        page.wait_for_timeout(100)
        inp = page.locator(f".hm-pf-dimbtn[data-dim='{d}'] ~ .hm-pf-dimdetail input.hm-pf-edit")
        inp.fill(text)
        if apply == 'enter': inp.press('Enter')
        else: page.locator(f".hm-pf-dimbtn[data-dim='{d}'] ~ .hm-pf-dimdetail button:has-text('Apply')").click()
        page.wait_for_timeout(300)
        msg = page.locator(f".hm-pf-dimbtn[data-dim='{d}'] ~ .hm-pf-dimdetail .hm-pf-msg").inner_text()
        return msg
    for units in ['cm', 'in']:
        page.evaluate(f"window.__human.ctx.setUnits('{units}')"); page.wait_for_timeout(300)
        fl0 = dim('femur_length'); 
        val = page.locator(".hm-pf-dimbtn[data-dim='femur_length']").evaluate("b=>b.querySelector('.hm-pf-dimval').textContent")
        print(units, 'femur', fl0, 'shown', val)
        page.evaluate("(d)=>{const b=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`); if(b.getAttribute('aria-expanded')!=='true') b.click()}", 'femur_length'); page.wait_for_timeout(100)
        print(' editor value', page.locator(".hm-pf-dimbtn[data-dim='femur_length'] ~ .hm-pf-dimdetail input.hm-pf-edit").input_value())
        # no-op apply
        m = edit('femur_length', page.locator(".hm-pf-dimbtn[data-dim='femur_length'] ~ .hm-pf-dimdetail input.hm-pf-edit").input_value())
        settle(); print(' noop apply -> femur', dim('femur_length'), 'diff mm', (dim('femur_length')-fl0)*1000, 'edited', page.evaluate("Object.keys(window.__human.ctx.getProfile().overrides||{})"))
        page.locator(".hm-pf-dimbtn[data-dim='femur_length'] ~ .hm-pf-dimdetail button:has-text('Revert')").click(); settle()
        for text, exp in ([('42,5', 425), ('4 2.5', 425), ('abc', None), ('', None), ('1e2', 100), ('-5', None), ('0', None), ('99999', None), ('Infinity', None), ('0x10', None), ('42.5cm', None)] if units=='cm' else [('16,5', 16.5*25.4), ('16.5', 16.5*25.4), ('1e1', 254), ('', None)]):
            m = edit('femur_length', text)
            if exp is not None:
                try: settle()
                except Exception as e: print('   settle timeout', text)
                print(f"  {text!r:10} -> femur {dim('femur_length')*1000:.1f} mm (expected {exp:.1f})", 'msg', repr(m)[:100], 'status', page.inner_text('.hm-pf-status')[:90])
            else: print(f"  {text!r:10} -> msg {m[:110]!r}")
            page.locator(".hm-pf-dimbtn[data-dim='femur_length'] ~ .hm-pf-dimdetail button:has-text('Revert')").click() if page.locator(".hm-pf-dimbtn[data-dim='femur_length'] ~ .hm-pf-dimdetail button:has-text('Revert')").count() else None
            settle()
    # stature in inches (measure path)
    m = edit('stature', '70.5'); settle(); print('stature 70.5 in ->', dim('stature')*1000, 'expected', 70.5*25.4, repr(m))
    page.evaluate("window.__human.ctx.setUnits('mm')"); page.wait_for_timeout(300)
    print('mass edit', repr(edit('mass', '90,5')), end=' '); settle(); print(page.evaluate("window.__human.ctx.getBody().mass"))
    print(page.evaluate("Object.entries(window.__human.ctx.getProfile().measures).filter(([k,m])=>m.status==='edited')"))
    errs=[l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]; print('errors', errs[:5])
