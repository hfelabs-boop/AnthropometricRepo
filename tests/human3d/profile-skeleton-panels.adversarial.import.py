"""Adversarial: the Import source of the real Profile panel with every accepted format and hostile files."""
import sys, json, os
sys.path.insert(0, 'tests/human3d')
from shot import browser
TMP = sys.argv[1]
mann = open('public/api/v1/mannequin/australia/army/' + os.listdir('public/api/v1/mannequin/australia/army')[0]).read() if os.path.isdir('public/api/v1/mannequin/australia/army') else None
print('mannequin sample file:', os.listdir('public/api/v1/mannequin/australia/army')[:3])
pops = open('public/api/v1/populations/united-states/army/M.json').read()
cases = {
 'csv-kv': "key,value,unit\nstature,1755,mm\nmass,80,kg\nsitting_height,925,mm\n",
 'csv-cm': "stature_cm,mass_kg\n175.5,80\n",
 'csv-header-row': "stature,mass,hand_length\n1755,80,190\n",
 'tsv': "key\tvalue\tunit\nstature\t1755\tmm\nmass\t80\tkg\n",
 'json-flat': '{"sex":"F","stature":"1650 mm","mass":"60 kg"}',
 'json-list': '[{"key":"stature","value":1700,"unit":"mm"},{"key":"mass","value":70,"unit":"kg"}]',
 'json-measures': '{"measures":{"stature":{"value":1.72,"unit":"m"},"mass":{"value":150,"unit":"lb"}}}',
 'populations-json': pops,
 'mannequin-json': mann,
 'bom-csv': "﻿key,value,unit\nstature,1755,mm\n",
 'crlf-csv': "key,value,unit\r\nstature,1755,mm\r\nmass,80,kg\r\n",
 'semicolon-decimal-comma': "key;value;unit\nstature;1755,5;mm\nmass;80,5;kg\n",
 'html': "<html><body>stature</body></html>",
 'empty': "   \n",
 'no-stature': "key,value,unit\nmass,80,kg\n",
 'stature-nan': '{"stature": "NaN"}',
 'stature-inf': '{"stature": 1e999}',
 'stature-neg': '{"stature": -1755}',
 'stature-tiny': '{"stature": 5}',
 'stature-huge': '{"stature": 99999}',
 'proto': '{"__proto__":{"polluted":1},"stature":1755,"constructor":5,"toString":3}',
 'formula': "key,value,unit\nstature,1755,mm\n=cmd|' /C calc'!A0,5,mm\n",
 'script-key': '{"stature":1755,"<img src=x onerror=alert(1)>":300}',
 'deep-json': '['*5000 + ']'*5000,
 'long-key': '{"stature":1755,"' + 'a'*100000 + '":3}',
 'many-keys': json.dumps({"stature": 1755, **{f"k{i}": i for i in range(50000)}}),
 'unit-mismatch': "key,value,unit\nstature,1755,kg\n",
 'unknown-unit': "key,value,unit\nstature,1755,furlong\n",
 'mass-only-m': '{"stature": 1.755, "mass": 80}',
 'dup': "key,value,unit\nstature,1700,mm\nstature,1800,mm\n",
}
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.click('.hm-pf-srcseg button:has-text("Import")')
    page.wait_for_selector('.hm-pf-paste')
    dialogs = []
    page.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
    for name, text in cases.items():
        if text is None: continue
        before = page.evaluate("window.__human.state.profile.id")
        page.fill('.hm-pf-paste', text)
        page.click('button:has-text("Use the pasted text")')
        page.wait_for_timeout(250)
        try:
            page.wait_for_function("!window.__human.state.busy", timeout=40000)
        except Exception: print(name, 'STILL BUSY')
        page.wait_for_timeout(150)
        r = page.evaluate("""()=>({err: document.querySelector('.hm-pf-importerr')?.innerText.slice(0,200), ok: document.querySelector('.hm-pf-importerr + .hm-pf-msg, .hm-pf-msg-ok')?.textContent, pid: window.__human.state.profile.id.slice(0,50), st: window.__human.state.body?.stature, ms: window.__human.state.body?.mass, label: window.__human.state.profile.label.slice(0,50), status: document.querySelector('.hm-pf-status').textContent.slice(0,90), fit: window.__human.state.notices.map(n=>n.id+':'+n.text.slice(0,100)), pol: ({}).polluted})""")
        print(f"{name}: err={r['err']!r} ok={r['ok']!r} -> {r['label']!r} stature={r['st']} mass={r['ms']} notices={r['fit']} pol={r['pol']}")
    print('dialogs', dialogs)
    # files
    def file(name, data, mime='text/plain'):
        p = os.path.join(TMP, name)
        open(p, 'wb').write(data if isinstance(data, bytes) else data.encode())
        return p
    for name, data in [('big.csv', b'a'*3_500_000), ('empty.csv', b''), ('bin.json', bytes(range(256))*50), ('x.xlsx', b'PK\x03\x04junk'), ('noext', b'stature,1755\n'), ('ok.csv', cases['csv-kv']), ('utf16.csv', cases['csv-kv'].encode('utf-16')), ('u.json', cases['json-flat'])]:
        p = file(name, data)
        page.set_input_files('input[type=file]', p)
        page.wait_for_timeout(1500)
        r = page.evaluate("""()=>({err: document.querySelector('.hm-pf-importerr')?.innerText.slice(0,220), ok: document.querySelector('.hm-pf-msg-ok')?.textContent, label: window.__human.state.profile.label.slice(0,50)})""")
        print(f"file {name}: {r}")
    # drop of text only / file
    print('pageerrors', [l for l in logs if l.startswith('[pageerror]')])
