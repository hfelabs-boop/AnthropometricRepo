"""Adversarial: every row of the dimension table in the real tab: selection target, edit, revert. patched=1 uses a shell.js that forwards form/overrides."""
import sys, json, os
sys.path.insert(0, 'tests/human3d')
from shot import browser
patched = len(sys.argv) > 1 and sys.argv[1] == '1'
OLD = "return m.fitBody(profile, { form: formOf(profile) });"
NEW = "return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });"
def patch(route):
    t = open('site/js/human/shell.js').read()
    assert OLD in t
    route.fulfill(body=t.replace(OLD, NEW), content_type='text/javascript')
def built(page):
    page.wait_for_function("()=>{const s=window.__human.state;return s.body&&s.profile&&s.body.profileId===s.profile.id&&!s.busy}", timeout=60000)
    page.wait_for_timeout(80)
with browser(1280, 800) as (page, logs):
    if patched: page.route("**/js/human/shell.js", patch)
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn', timeout=30000)
    built(page)
    ids = page.evaluate("[...document.querySelectorAll('.hm-pf-dimbtn')].map(b=>b.dataset.dim)")
    print(len(ids), 'rows; patched', patched)
    dims0 = page.evaluate("window.__human.state.body.dims.map(d=>[d.id,d.value])")
    body_ids = [d[0] for d in dims0]
    print('rows == body.dims:', sorted(ids) == sorted(body_ids), set(ids) ^ set(body_ids))
    probs = []
    for i in ids:
        page.evaluate("(i)=>{document.querySelector(`.hm-pf-dimbtn[data-dim=\"${i}\"]`).scrollIntoView({block:'center'})}", i)
        page.click(f'.hm-pf-dimbtn[data-dim="{i}"]')
        page.wait_for_timeout(60)
        sel = page.evaluate("()=>({sel: window.__human.state.selection, det: !!document.querySelector('.hm-pf-dimdetail'), exp: document.querySelector('.hm-pf-dimbtn[aria-expanded=true]')?.dataset.dim})")
        target = page.evaluate("(i)=>null", i)
        if sel['exp'] != i or not sel['det']: probs.append((i, 'row did not open', sel))
        if not sel['sel']: probs.append((i, 'no selection after opening', sel))
        # edit
        inp = page.locator('.hm-pf-dimdetail input.hm-pf-edit')
        if inp.count():
            v0 = float(inp.input_value())
            nv = round(v0 * 1.05, 1) if v0 else 10
            inp.fill(str(nv)); inp.press('Enter')
            page.wait_for_timeout(200)
            try: built(page)
            except Exception: probs.append((i, 'edit never finished building'))
            r = page.evaluate("(i)=>{const d=window.__human.state.body.dims.find(d=>d.id===i);return {v:d.value,note:d.note,st:d.status,notices:window.__human.state.notices.map(n=>n.text.slice(0,90)),status:document.querySelector('.hm-pf-status').textContent.slice(0,150),edited:!![...document.querySelectorAll(`.hm-pf-dimbtn[data-dim=\"${i}\"] .hm-st-edited`)].length,open:document.querySelector('.hm-pf-dimbtn[aria-expanded=true]')?.dataset.dim, pid:window.__human.state.profile.id}}", i)
            got = r['v'] * (1 if i == 'mass' else 1000)
            if abs(got - nv) / nv > 0.004: probs.append((i, f'asked {nv} got {got:.1f}', r['status'], r['notices']))
            if not r['edited']: probs.append((i, 'not marked edited'))
            if r['open'] != i: probs.append((i, 'row closed after edit', r['open']))
            # revert
            rb = page.locator('.hm-pf-dimdetail button:has-text("Revert")')
            if rb.count():
                rb.click(); page.wait_for_timeout(200)
                try: built(page)
                except Exception: probs.append((i, 'revert never finished'))
                d1 = page.evaluate("window.__human.state.body.dims.map(d=>[d.id,d.value])")
                if json.dumps(d1) != json.dumps(dims0): probs.append((i, 'revert did not restore all dims', [ (a[0], a[1], b[1]) for a, b in zip(dims0, d1) if a != b][:3]))
            else: probs.append((i, 'no Revert button after edit'))
    for p in probs: print('PROBLEM', p)
    print('notices at end', page.evaluate("window.__human.state.notices.map(n=>n.text.slice(0,200))"))
    print('console errors:', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')][:10])
