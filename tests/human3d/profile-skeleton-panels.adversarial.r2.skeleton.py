"""Round 2: Skeleton panel in the real tab: all joints reachable, each click selects the right joint, inspector survives tab switches, CSV axes/units, landmark list.
   python tests/human3d/profile-skeleton-panels.adversarial.r2.skeleton.py"""
import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 900) as (page, logs):
    page.on('crash', lambda: print('PAGE CRASHED'))
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    # open the dimension row first (profile tab) BEFORE skeleton was ever opened
    page.click('[role=tab]:has-text("Skeleton")')
    page.wait_for_selector('.hm-sk-tree')
    page.wait_for_timeout(500)
    page.click('button:has-text("Expand all")')
    n = page.evaluate("[...document.querySelectorAll('.hm-sk-joint')].filter(e=>!e.hidden).length")
    print('visible joint leaves after expand all', n)
    ids = page.evaluate("[...document.querySelectorAll('.hm-sk-joint')].map(e=>e.dataset.node)")
    print('joint leaves total', len(ids), 'unique', len(set(ids)))
    bad = []
    for jid in ids:
        j = jid[2:]
        page.evaluate("(n)=>document.querySelector(`[data-node='${n}']`).click()", jid)
        page.wait_for_timeout(30)
        r = page.evaluate("""(j)=>{const s=window.__human.state.selection; const insp=document.getElementById('hm-inspector-body'); 
          return {sel:s, title:document.getElementById('hm-inspector-title').textContent, txt: insp.innerText.slice(0,80), id: /Joint id: (\\S+)/.exec(insp.innerText)?.[1], seg: /Rest segment|Height above/i.test(insp.innerText), setby: /Set by|Placed by|At the elbow|Also moved|root/.test(insp.innerText), selected: document.querySelectorAll('.hm-sk-joint[aria-selected=true]').length}}""", j)
        if not (r['sel'] and r['sel']['id']==j and r['id']==j and r['selected']==1 and r['seg']):
            bad.append((j, r))
    print('bad', len(bad), bad[:3])
    # flows: keyboard on tree
    page.fill('input[aria-label="Search joints"]', 'index')
    print('search index ->', page.evaluate("[...document.querySelectorAll('.hm-sk-joint')].filter(e=>!e.hidden).map(e=>e.dataset.node)"))
    page.fill('input[aria-label="Search joints"]', 'zzzz')
    print('none visible msg', page.evaluate("!document.querySelector('.hm-sk-none').hidden"))
    page.fill('input[aria-label="Search joints"]', '')
    # CSV coordinates
    csv = page.evaluate("""async()=>{ let t=''; const nav=navigator; const orig=nav.clipboard.writeText.bind(nav.clipboard); return null }""")
    page.click('summary:has-text("Points for CAD")')
    with page.expect_download() as dl:
        page.click('button:has-text("Download CSV")')
    path = dl.value.path()
    text = open(path).read()
    lines = text.strip().split('\n')
    print(len(lines)-1, 'csv rows; header', lines[0]); print(lines[1]); 
    import csv as C, io
    rows = list(C.DictReader(io.StringIO(text)))
    byid = {(r['type'], r['id']): r for r in rows}
    def p(t,i): r=byid[(t,i)]; return (float(r['x_mm']),float(r['y_mm']),float(r['z_mm']))
    print('shoulder_L', p('joint','shoulder_L'), 'shoulder_R', p('joint','shoulder_R'), 'pelvis', p('joint','pelvis'), 'head', p('joint','head'))
    print('toe_tip_L', [ (k,v) for k,v in byid.items() if k[1].startswith('toe_tip_L')][:1])
    print('vertex', p('landmark','vertex'))
    st = page.evaluate("window.__human.ctx.getBody().stature*1000")
    print('stature', st)
    # compare csv with live rig
    live = page.evaluate("""()=>{const rig=window.__human.ctx.getRig(); const o={}; for (const id of ['shoulder_L','knee_R','pelvis']) {const v=rig.jointWorld(id); o[id]=[v.x*1000,v.y*1000,v.z*1000]} const l=rig.landmarkWorld('vertex'); o.vertex=[l.x*1000,l.y*1000,l.z*1000]; return o}""")
    print('live', live)
    # csv for odd values
    print('nonfinite', [r for r in rows if any(x in r[c].lower() for c in ('x_mm','y_mm','z_mm') for x in ('nan','inf','e+','e-'))][:3], 'empty', [r['id'] for r in rows if '' in (r['x_mm'],r['y_mm'],r['z_mm'])][:3])
    dups = {}
    for r in rows: dups.setdefault((r['type'],r['id']), 0); dups[(r['type'],r['id'])]+=1
    print('dups', [k for k,v in dups.items() if v>1][:5])
    # landmark section
    page.click('summary:has-text("Landmarks")')
    page.wait_for_timeout(300)
    print('landmark items', page.evaluate("document.querySelectorAll('.hm-sk-lm').length"), 'csv landmarks', sum(1 for r in rows if r['type']=='landmark'))
    errs=[l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]') or l.startswith('[warning]')]
    print(len(errs),'errors/warnings', errs[:8])
