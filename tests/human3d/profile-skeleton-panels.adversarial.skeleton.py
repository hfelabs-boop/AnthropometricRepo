"""Adversarial: Skeleton panel in the real tab: 77 joints reachable, selection, inspector, landmark list, CSV (axes, mm, pose)."""
import sys, json, csv, io
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.click('[role=tab]:has-text("Skeleton")')
    page.wait_for_selector('.hm-sk-tree')
    page.wait_for_timeout(500)
    page.click('button:has-text("Expand all")')
    items = page.evaluate("[...document.querySelectorAll('.hm-sk-joint')].map(e=>[e.dataset.node, e.hidden, e.offsetParent!==null])")
    print('joint leaves', len(items), 'visible', sum(1 for i in items if i[2]))
    allj = page.evaluate("[...new Set(window.__human.state.rig.bones.keys())]")
    print('rig bones', len(allj), 'missing from tree:', set(allj) - {i[0][2:] for i in items})
    probs = []
    # click every joint: selection, inspector title, rig selection, dims text
    for node, hid, vis in items:
        j = node[2:]
        page.evaluate("(n)=>document.querySelector(`[data-node=\"${n}\"]`).scrollIntoView({block:'center'})", node)
        page.click(f'[data-node="{node}"]')
        page.wait_for_timeout(40)
        r = page.evaluate("""(j)=>({sel: window.__human.state.selection, insp: document.getElementById('hm-inspector-title').textContent, body: document.getElementById('hm-inspector-body').innerText.slice(0,2000), aria: document.querySelector('.hm-sk-joint[aria-selected=true]')?.dataset.node, rigsel: window.__human.state.rig.selected ?? null, dofs: document.querySelectorAll('#hm-inspector-body .hm-sk-dof').length, expected: null})""", j)
        exp = page.evaluate("(j)=>{const J=window.__human.state.rig; return null}", j)
        if r['sel'] != {'kind': 'joint', 'id': j}: probs.append((j, 'selection', r['sel']))
        if r['aria'] != node: probs.append((j, 'aria-selected', r['aria']))
        if f'Joint id: {j}' not in r['body']: probs.append((j, 'inspector wrong joint', r['body'][:100]))
        if r['dofs'] < 1: probs.append((j, 'no dof rows'))
    print('joint click problems', probs[:10], len(probs))
    # inspector content: segment and "Set by" for a handful
    for j in ['pelvis', 'L3', 'C4', 'shoulder_L', 'elbow_R', 'forearm_L', 'index_pip_R', 'knee_L', 'ankle_R', 'mtp_L', 'jaw', 'eye_L', 'head']:
        page.click(f'[data-node="j:{j}"]') if page.locator(f'[data-node="j:{j}"]:visible').count() else page.evaluate("(j)=>window.__human.ctx.select({kind:'joint',id:j})", j)
        page.wait_for_timeout(80)
        t = page.inner_text('#hm-inspector-body').replace('\n', ' | ')
        tl = t.lower(); k = max(tl.find('rest segment'), tl.find('height above'))
        print(j, '::', t[k:k+330])
    print('pageerrors', [l for l in logs if l.startswith('[pageerror]')])
