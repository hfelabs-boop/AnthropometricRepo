"""Mean of each length-type measure as a fraction of stature (standing) or sitting height (seated), n-weighted across the roll-up groups."""
import csv, json, collections, sys
from pathlib import Path
rows=list(csv.DictReader(open(Path(__file__).resolve().parents[2] / 'aggregates' / 'rollup.csv')))
by=collections.defaultdict(dict)
for r in rows:
    try: m=float(r['mean']); n=float(r['n_total'] or 0)
    except: continue
    by[(r['country'],r['service_role'],r['sex'])][r['measure_key']]=(m,n)
def fr(den):
    acc=collections.defaultdict(lambda:[0,0])
    for g,d in by.items():
        if den not in d or g[2] not in "MF": continue
        D=d[den][0]
        if D<=0: continue
        for k,(m,n) in d.items():
            if k==den: continue
            a=acc[(k,g[2])]; a[0]+=m/D*n; a[1]+=n
    out=collections.defaultdict(dict)
    for (k,s),(a,n) in acc.items():
        if n>0: out[k][s]=(a/n,n)
    return out
FS=fr('stature'); FH=fr('sitting_height')
if __name__=="__main__":
    for k in sys.argv[1:]:
        print(k,{s:(round(v[0],4),int(v[1])) for s,v in FS.get(k,{}).items()},"| sit",{s:(round(v[0],4),int(v[1])) for s,v in FH.get(k,{}).items()})
