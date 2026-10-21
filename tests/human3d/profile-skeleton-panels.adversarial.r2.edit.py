"""Round 2: dimension edits in the REAL tab (unpatched shell): every editable row, edit +5 %, check what the body did and what the panel says; revert.
   python tests/human3d/profile-skeleton-panels.adversarial.r2.edit.py [OUTDIR]"""
import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1] if len(sys.argv) > 1 else None
with browser(1280, 900) as (page, logs):
    if 'patch' in sys.argv:
        from pathlib import Path
        t = Path('site/js/human/shell.js').read_text().replace("return m.fitBody(profile, { form: formOf(profile) });", "return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });")
        page.route('**/js/human/shell.js', lambda r: r.fulfill(body=t, content_type='text/javascript'))
    page.on('crash', lambda: print('PAGE CRASHED'))
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.wait_for_timeout(800)
    ids = page.evaluate("[...document.querySelectorAll('.hm-pf-dimbtn')].map(b=>b.dataset.dim)")
    print(len(ids), 'rows')
    res = []
    for did in ids:
        page.evaluate("(d)=>{const b=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`); b.scrollIntoView(); b.click();}", did)
        page.wait_for_timeout(60)
        info = page.evaluate("""(d)=>{const li=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`).closest('li'); const inp=li.querySelector('input.hm-pf-edit'); return {hasEdit:!!inp, val: inp&&inp.value, sel: window.__human.state.selection, detail: li.querySelector('.hm-pf-dimdetail')?.innerText.slice(0,0)}}""", did)
        row = {"id": did, **info}
        print('row', did, flush=True)
        if info['hasEdit']:
            before = page.evaluate("(d)=>{const b=window.__human.ctx.getBody(); const x=b.dims.find(q=>q.id===d); return x.value}", did)
            v = float(info['val'].replace(',', ''))
            nv = round(v * 1.04, 1) if did != 'shoulder_protraction' else 12
            page.evaluate("([d,v])=>{const li=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`).closest('li'); const i=li.querySelector('input.hm-pf-edit'); i.value=String(v); [...li.querySelectorAll('button')].find(b=>b.textContent==='Apply').click();}", [did, nv])
            try:
                page.wait_for_function("()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}", timeout=30000)
            except Exception as e: row['timeout']=True
            page.wait_for_timeout(250)
            after = page.evaluate("(d)=>{const b=window.__human.ctx.getBody(); const x=b.dims.find(q=>q.id===d); const li=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`)?.closest('li'); return {value:x.value, note:x.note, status: document.querySelector('.hm-pf-status').innerText, msg: li?.querySelector('.hm-pf-msg')?.innerText, notices: window.__human.state.notices.map(n=>n.text.slice(0,140))}}", did)
            row.update(before=before, nv=nv, after=after)
            # revert
            clicked = page.evaluate("(d)=>{const li=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`)?.closest('li'); const b=li&&[...li.querySelectorAll('button')].find(b=>b.textContent==='Revert'); if(b){b.click(); return true} return false}", did)
            row['revertClicked'] = clicked
            if clicked:
                page.wait_for_function("()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}", timeout=30000)
                page.wait_for_timeout(200)
                row['reverted'] = page.evaluate("(d)=>window.__human.ctx.getBody().dims.find(q=>q.id===d).value", did)
                row['edits'] = page.evaluate("(()=>{const p=window.__human.ctx.getProfile(); return [p.id, Object.keys(p.overrides||{}).length, Object.values(p.measures).filter(m=>m.status==='edited').length]})()")
        res.append(row)
    for r in res:
        if r.get('hasEdit'):
            a = r['after']
            print(f"{r['id']:26s} before {r['before']:.4f} asked {r['nv']} after {a['value']:.4f} reverted {r.get('reverted')} edits {r.get('edits')} | {a['status'][:90]!r} {a['msg']!r} {len(a['notices'])}n")
        else:
            print(f"{r['id']:26s} not editable; sel={r['sel']}")
    errs=[l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
    print(len(errs),'errors', errs[:5])
