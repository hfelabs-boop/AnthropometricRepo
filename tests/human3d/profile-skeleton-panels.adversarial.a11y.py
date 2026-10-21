import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
for dark, w, h, tag, mobile in [(True, 1280, 800, 'D-desk', False), (False, 390, 800, 'L-mob', True)]:
  with browser(w, h, dark=dark, mobile=mobile) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn')
    # a11y static audit of panel DOM
    audit = page.evaluate("""()=>{
      const root=document.querySelector('.hm-pf'); const res={unlabeled:[], dupIds:[], btnNoName:[], imgNoLabel:[]};
      const ids={}; document.querySelectorAll('[id]').forEach(e=>{ids[e.id]=(ids[e.id]||0)+1}); res.dupIds=Object.entries(ids).filter(([k,v])=>v>1).map(([k])=>k);
      for (const e of root.querySelectorAll('input,select,textarea')) { if (e.type==='hidden') continue; const lab = e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||(e.id&&document.querySelector(`label[for="${e.id}"]`))||e.closest('label'); if(!lab) res.unlabeled.push(e.outerHTML.slice(0,100)); }
      for (const b of root.querySelectorAll('button')) { if (!(b.textContent.trim()||b.getAttribute('aria-label')||b.title)) res.btnNoName.push(b.outerHTML.slice(0,100)); }
      for (const b of root.querySelectorAll('[role=img]')) if(!b.getAttribute('aria-label')) res.imgNoLabel.push(b.outerHTML.slice(0,80));
      res.liveRegions=[...document.querySelectorAll('[aria-live],[role=status],[role=alert]')].filter(e=>root.contains(e)).map(e=>e.className+':'+(e.getAttribute('role')||e.getAttribute('aria-live')));
      return res}""")
    print(tag, json.dumps(audit)[:1500])
    # focus visible: tab through first controls and check outline
    page.click('.hm-pf-srcseg button >> nth=0')
    ring = []
    for i in range(14):
        page.keyboard.press('Tab')
        ring.append(page.evaluate("()=>{const e=document.activeElement, cs=getComputedStyle(e); return [e.tagName, (e.textContent||e.getAttribute('aria-label')||e.id||'').trim().slice(0,28), cs.outlineStyle+' '+cs.outlineWidth, cs.boxShadow!=='none']}"))
    print(tag, 'tab order', ring)
    page.screenshot(path=f'{out}/{tag}-focus.png')
    # skeleton: keyboard tree + selection screenshot
    page.click('[role=tab]:has-text("Skeleton")'); page.wait_for_selector('.hm-sk-tree')
    page.evaluate("window.__human.ctx.select({kind:'joint', id:'shoulder_L'})"); page.wait_for_timeout(600)
    page.click('summary:has-text("Landmarks")'); page.wait_for_timeout(400)
    page.screenshot(path=f'{out}/{tag}-sk-selected.png')
    # keyboard tree nav
    page.focus('[data-node="g:spine"]')
    for k in ['ArrowRight', 'ArrowDown', 'ArrowDown', 'End', 'Home', 'Enter']:
        page.keyboard.press(k)
    print(tag, 'after keys: focus', page.evaluate("document.activeElement.dataset.node"), 'selection', page.evaluate("window.__human.state.selection"))
    print(tag, 'tree a11y', page.evaluate("()=>({tablestops:[...document.querySelectorAll('.hm-sk-item')].filter(e=>e.tabIndex===0).length, roleTree:!!document.querySelector('[role=tree]'), groupsWithoutRoleGroup: document.querySelectorAll('[role=treeitem][aria-expanded]').length, childrenNotInGroup:true})"))
    print(tag, 'errors', [l[:150] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
