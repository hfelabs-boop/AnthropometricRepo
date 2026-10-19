"""Round 3: Skeleton tree by keyboard: all 77 joints reachable and selectable, selection / inspector / rig highlight agree, search, collapse."""
import sys, time
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()")
    page.wait_for_selector('.hm-sk .hm-sk-item', timeout=30000)
    page.click('button:has-text("Expand all")')
    page.focus('.hm-sk-item[tabindex="0"]')
    page.keyboard.press('Home')
    seen = []; bad = []
    for i in range(140):
        info = page.evaluate("()=>{const e=document.activeElement; return {node:e.dataset.node, hidden:e.hidden, lvl:e.getAttribute('aria-level')}}")
        if info['node'] is None: bad.append(('focus lost', i)); break
        if info['node'].startswith('j:'):
            seen.append(info['node'][2:])
            page.keyboard.press('Enter')
            sel = page.evaluate("()=>({sel: window.__human.state.selection, title: document.querySelector('#hm-inspector-title').textContent, ariaSel: [...document.querySelectorAll('.hm-sk-item[aria-selected=true]')].map(e=>e.dataset.node), focus: document.activeElement.dataset.node, rigSel: window.__human.ctx.getRig().selected ?? null})")
            if sel['sel'] != {'kind': 'joint', 'id': info['node'][2:]} or sel['ariaSel'] != [info['node']]: bad.append((info['node'], sel))
            if sel['focus'] != info['node']: bad.append(('focus moved after Enter', info['node'], sel['focus']))
        before = info['node']
        page.keyboard.press('ArrowDown')
        after = page.evaluate("document.activeElement.dataset.node")
        if after == before: break
    print('joints seen', len(seen), 'unique', len(set(seen)), 'bad', bad[:4])
    # Right/Left on groups
    page.keyboard.press('Home'); page.keyboard.press('ArrowLeft')
    print('after ArrowLeft on first group, aria-expanded:', page.evaluate("document.activeElement.getAttribute('aria-expanded')"), 'visible items', page.evaluate("[...document.querySelectorAll('.hm-sk-item')].filter(e=>!e.hidden).length"))
    # search: every joint findable by its label
    miss = []
    allj = page.evaluate("[...document.querySelectorAll('.hm-sk-joint')].map(e=>[e.dataset.node.slice(2), e.title])")
    for jid, title in allj[::7]:
        page.fill('input[aria-label="Search joints"]', jid)
        vis = page.evaluate("[...document.querySelectorAll('.hm-sk-joint')].filter(e=>!e.hidden).map(e=>e.dataset.node.slice(2))")
        if jid not in vis: miss.append(jid)
    page.fill('input[aria-label="Search joints"]', 'zzzz'); print('empty msg visible', page.evaluate("!document.querySelector('.hm-sk-none').hidden"))
    page.fill('input[aria-label="Search joints"]', '')
    print('search misses', miss)
    # select from 3D (ctx.select) and check tree scroll/open
    page.click('button:has-text("Collapse all")')
    page.evaluate("window.__human.ctx.select({kind:'joint', id:'little_dip_R'})"); page.wait_for_timeout(300)
    print('collapsed then select little_dip_R -> visible', page.evaluate("!document.querySelector('[data-node=\"j:little_dip_R\"]').hidden"), 'inspector', page.inner_text('#hm-inspector-title'))
    # select a landmark, then a bogus joint
    page.evaluate("window.__human.ctx.select({kind:'landmark', id:'vertex'})"); page.wait_for_timeout(200)
    print('landmark inspector', page.inner_text('#hm-inspector-title'), '|', page.inner_text('#hm-inspector-body')[:200].replace('\n',' / '))
    try:
        page.evaluate("window.__human.ctx.select({kind:'joint', id:'nope'})")
    except Exception as e: print('bogus select raised:', str(e)[:100])
    print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')][:5])
