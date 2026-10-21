"""Round 3: DOM accessibility audit of every source view of the Profile panel and of the Skeleton panel in the real tab."""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
AUDIT = """(rootSel)=>{
  const root=document.querySelector(rootSel); const out=[];
  const vis=(e)=>{const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return !e.closest('[hidden]') && s.display!=='none' && s.visibility!=='hidden'};
  const name=(e)=>{ let n=e.getAttribute('aria-label'); if(n) return n; const lb=e.getAttribute('aria-labelledby'); if(lb) return lb.split(' ').map(i=>document.getElementById(i)?.textContent).join(' ');
    if(e.labels&&e.labels.length) return [...e.labels].map(l=>l.textContent).join(' '); if(e.title) return e.title; return (e.textContent||'').trim()};
  for(const e of root.querySelectorAll('button,input,select,textarea,summary,[role=button],[role=treeitem],a[href]')){
    if(!vis(e)) continue; if(!name(e).trim()) out.push('NO NAME: '+e.outerHTML.slice(0,140));
    if(e.tabIndex>0) out.push('tabindex>0 '+e.outerHTML.slice(0,100));
  }
  const ids=[...document.querySelectorAll('[id]')].map(e=>e.id); const dup=ids.filter((x,i)=>ids.indexOf(x)!==i); if(dup.length) out.push('DUP IDS '+[...new Set(dup)].join(','));
  for(const e of root.querySelectorAll('[aria-controls]')) for(const i of e.getAttribute('aria-controls').split(' ')) if(!document.getElementById(i)) out.push('aria-controls missing '+i);
  for(const e of root.querySelectorAll('[aria-labelledby],[aria-describedby]')) for(const i of (e.getAttribute('aria-labelledby')||e.getAttribute('aria-describedby')).split(' ')) if(!document.getElementById(i)) out.push('aria ref missing '+i);
  // contrast-ish: text colour equals background?
  // horizontal overflow
  const sc=root.closest('.hm-panel-body, .hm-left, [role=tabpanel]')||root; if(sc.scrollWidth>sc.clientWidth+1) out.push('H-OVERFLOW '+sc.className+' '+sc.scrollWidth+'>'+sc.clientWidth);
  for(const e of root.querySelectorAll('*')){ if(!vis(e)) continue; const r=e.getBoundingClientRect(); const pr=root.getBoundingClientRect(); if(r.width>0 && (r.right>pr.right+1)) {out.push('OVERFLOWS PARENT '+e.tagName+'.'+e.className+' '+Math.round(r.right-pr.right)); if(out.length>40) break;} }
  const hs=[...root.querySelectorAll('h1,h2,h3,h4')].map(h=>h.tagName); out.push('headings '+hs.join(','));
  return out;}"""
def run(w, dark):
    with browser(w, 800, dark=dark) as (page, logs):
        page.goto(page.base + '/#/human?debug')
        page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
        page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
        page.evaluate("document.querySelectorAll('.hm-pf details.hm-section').forEach(d=>d.open=true)")
        for src in ['Population', 'Individual', 'Import', 'Manual']:
            page.click(f'.hm-pf-srcseg button:has-text("{src}")'); page.wait_for_timeout(1200 if src == 'Individual' else 300)
            if src == 'Population':
                page.click('.hm-pf-dimbtn[data-dim="hand_length"]'); page.wait_for_timeout(200)
            print(w, 'dark' if dark else 'light', src, [x for x in page.evaluate(AUDIT, '.hm-pf')])
        page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()")
        page.wait_for_selector('.hm-sk .hm-sk-item', timeout=30000)
        page.evaluate("document.querySelectorAll('.hm-sk details.hm-section').forEach(d=>d.open=true)")
        page.wait_for_timeout(400)
        print(w, 'skeleton', page.evaluate(AUDIT, '.hm-sk'))
        print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')][:4])
run(1280, False); run(360, True)
