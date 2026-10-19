"""Round 2: Skeleton panel in a posed state: tree angles, inspector numbers, landmark list and CSV follow the pose; left arm abducted -> wrist_L at +X."""
import sys, csv, io
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.click('[role=tab]:has-text("Skeleton")'); page.wait_for_selector('.hm-sk-tree'); page.wait_for_timeout(400)
    page.click('button:has-text("Expand all")'); page.click('[data-node="j:shoulder_L"]'); page.click('summary:has-text("Landmarks")')
    page.evaluate("()=>{window.__human.ctx.getRig().setPose({root:{heading:90, x:0.5}, angles:{shoulder_L:[0,90,0], knee_R:[60,0], head:[0,0,45]}})}")
    page.wait_for_timeout(400)
    print('tree row', page.inner_text('[data-node="j:shoulder_L"]').replace('\n', ' | '))
    print('knee_R', page.inner_text('[data-node="j:knee_R"]').replace('\n', ' | '))
    print('inspector dof', page.inner_text('#hm-inspector-body')[:260].replace('\n', ' | '))
    print('landmark wrist-ish', page.evaluate("[...document.querySelectorAll('.hm-sk-lm')].filter(e=>/stylion/i.test(e.innerText)).map(e=>e.innerText.replace(/\\n/g,' | '))"))
    page.click('summary:has-text("Points for CAD")')
    with page.expect_download() as dl: page.click('button:has-text("Download CSV")')
    rows = {(r['type'], r['id']): r for r in csv.DictReader(io.StringIO(open(dl.value.path()).read()))}
    live = page.evaluate("()=>{const r=window.__human.ctx.getRig(); const o={}; for (const id of ['shoulder_L','wrist_L','knee_R','pelvis']) {const v=r.jointWorld(id); o[id]=[v.x*1000,v.y*1000,v.z*1000]} return o}")
    for j in live: print(j, 'csv', [rows[('joint', j)][c] for c in ('x_mm','y_mm','z_mm')], 'live', [round(v,1) for v in live[j]])
    # abduct +90 of the left arm with heading 90: the arm points to the figure's left (= +X rotated by heading).
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
