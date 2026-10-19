"""Round 3: the CSV of joints and landmarks, downloaded in the real tab, in neutral and posed states: axes, millimetres, row counts, quoting."""
import sys, csv, io
sys.path.insert(0, 'tests/human3d')
from shot import browser
def grab(page):
    with page.expect_download() as d:
        page.click('button:has-text("Download CSV")')
    p = d.value.path()
    return d.value.suggested_filename, open(p, encoding='utf-8').read()
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()")
    page.wait_for_selector('.hm-sk .hm-sk-item', timeout=30000)
    page.evaluate("document.querySelectorAll('.hm-sk details.hm-section').forEach(d=>d.open=true)")
    name, txt = grab(page)
    print(name, len(txt))
    rows = list(csv.DictReader(io.StringIO(txt)))
    print(len(rows), rows[0].keys())
    ref = page.evaluate("""()=>{const r=window.__human.ctx.getRig(); const o={}; for(const [id,l] of Object.entries(r.body.landmarks)){const p=r.landmarkWorld(id); o['l:'+id]=[p.x*1000,p.y*1000,p.z*1000]} for(const [id] of r.bones){const p=r.jointWorld(id); o['j:'+id]=[p.x*1000,p.y*1000,p.z*1000]} return {o, stature: r.body.stature*1000, nl:Object.keys(r.body.landmarks).length, nj:r.bones.size}}""")
    print('landmarks', ref['nl'], 'joints', ref['nj'], 'rows', len(rows))
    bad = 0
    for r in rows:
        k = ('j:' if r['type']=='joint' else 'l:') + r['id']
        e = ref['o'].get(k)
        if e is None: print('no ref', k); bad+=1; continue
        g = [float(r['x_mm']), float(r['y_mm']), float(r['z_mm'])]
        if max(abs(a-b) for a,b in zip(g,e)) > 0.06: print('MISMATCH', k, g, e); bad+=1
    print('mismatches', bad)
    byid = {(r['type'], r['id']): r for r in rows}
    v = byid[('landmark','vertex')]; print('vertex', v['x_mm'], v['y_mm'], v['z_mm'], 'stature', ref['stature'])
    for a in ['acromion_L','acromion_R','toe_tip_L','toe_tip_R','heel_L','ectocanthus_L']:
        r = byid.get(('landmark', a)); print(a, r and (r['x_mm'], r['y_mm'], r['z_mm']))
    print('shoulder_L', byid[('joint','shoulder_L')]['x_mm'], 'shoulder_R', byid[('joint','shoulder_R')]['x_mm'])
    # any label with comma/quote/newline/formula chars
    odd = [r['label'] for r in rows if any(c in r['label'] for c in ',"\n') or r['label'][:1] in '=+-@']
    print('odd labels', odd[:5])
    # pose the rig: knee flex 90 + hip flex, then CSV again
    page.evaluate("""()=>{const r=window.__human.ctx.getRig(); r.setPose({angles:{knee_L:[90,0],hip_L:[90,0,0]}, root:{y: r.getPose().root.y}})}""")
    page.wait_for_timeout(300)
    name2, txt2 = grab(page)
    rows2 = {(r['type'], r['id']): r for r in csv.DictReader(io.StringIO(txt2))}
    ref2 = page.evaluate("""()=>{const r=window.__human.ctx.getRig(); const p=r.jointWorld('ankle_L'); const q=r.landmarkWorld('toe_tip_L'); return {ankle:[p.x*1000,p.y*1000,p.z*1000], toe:[q.x*1000,q.y*1000,q.z*1000]}}""")
    a = rows2[('joint','ankle_L')]; print('posed ankle csv', a['x_mm'], a['y_mm'], a['z_mm'], 'rig', ref2['ankle'])
    # copy path with clipboard denied
    page.click('button:has-text("Copy as CSV")'); page.wait_for_timeout(500)
    print('copy status:', page.inner_text('.hm-sk [role=status]:near(button:has-text("Download CSV"))')[:100] if False else page.evaluate("[...document.querySelectorAll('.hm-sk p[role=status]')].map(e=>e.textContent).filter(Boolean)"))
    # profile id odd chars in filename
    print([l for l in logs if l.startswith('[pageerror]')])
