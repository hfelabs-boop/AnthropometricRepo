import sys, json, csv, io, math
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.click('[role=tab]:has-text("Skeleton")')
    page.wait_for_selector('.hm-sk-tree')
    page.click('summary:has-text("Points for CAD")')
    def get_csv():
        with page.expect_download() as d:
            page.click('button:has-text("Download CSV")')
        dl = d.value
        path = dl.path()
        return dl.suggested_filename, open(path, encoding='utf-8').read()
    def check(tag):
        name, text = get_csv()
        rows = list(csv.DictReader(io.StringIO(text)))
        print(tag, name, len(rows), 'rows; header', text.splitlines()[0])
        truth = page.evaluate("""()=>{const r=window.__human.state.rig, T=window.__human.ctx.viewport; r.group.updateWorldMatrix(true,true);
          const out={}; for (const [id,b] of r.bones) {const v=b.getWorldPosition(new r.group.position.constructor()); out['j:'+id]=[v.x*1000,v.y*1000,v.z*1000];}
          for (const id of r.landmarkIds) {const v=r.landmarkWorld(id); out['l:'+id]=[v.x*1000,v.y*1000,v.z*1000];} return out}""")
        bad = 0; maxd = 0
        for r in rows:
            key = ('j:' if r['type'] == 'joint' else 'l:') + r['id']
            t = truth.get(key)
            if not t: print('no truth for', key); bad += 1; continue
            p = [float(r['x_mm']), float(r['y_mm']), float(r['z_mm'])]
            d = max(abs(a - b) for a, b in zip(p, t)); maxd = max(maxd, d)
            if d > 0.06: bad += 1; print('MISMATCH', key, p, t)
        print(tag, 'max diff mm', round(maxd, 3), 'bad', bad)
        j = {r['id']: r for r in rows if r['type'] == 'joint'}
        print(' hip_L x', j['hip_L']['x_mm'], 'hip_R x', j['hip_R']['x_mm'], 'head y', j['head']['y_mm'], 'pelvis y', j['pelvis']['y_mm'], 'toe z', next(r for r in rows if r['id'] == 'toe_tip_L')['z_mm'] if any(r['id']=='toe_tip_L' for r in rows) else None)
        ys = [float(r['y_mm']) for r in rows if r['type'] == 'landmark']
        print(' min landmark y', min(ys), 'max', max(ys))
        # csv sanity
        for r in rows:
            for k, v in r.items():
                if v is None: print('MISSING cell', r['id'], k)
                if k.endswith('_mm') and not math.isfinite(float(v)): print('NaN', r['id'])
                if v and v[0] in '=+-@' and k not in ('x_mm', 'y_mm', 'z_mm'): print('formula-like cell', k, v)
        return rows
    check('neutral')
    # posed state
    page.evaluate("""()=>{const r=window.__human.state.rig; r.setPose({root:{heading:30, y: r.root.y}, angles:{elbow_L:[90], shoulder_R:[60,20,0], knee_L:[45], hip_L:[50,0,0], L3:[10,5,5]}})}""")
    page.wait_for_timeout(300)
    check('posed')
    # unit toggle should not change CSV
    page.evaluate("window.__human.ctx.setUnits('in')"); page.wait_for_timeout(200)
    name, text = get_csv(); print('inches: first rows', text.splitlines()[1:3])
    print('pageerrors', [l for l in logs if l.startswith('[pageerror]')])
