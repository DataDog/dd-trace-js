import json, random, statistics as st, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.startswith('{')]
print('exits', sorted({(r['arm'], r['exit']) for r in rows}), sorted({r['tests'] for r in rows}))
p = {}
for r in rows:
    p.setdefault(r['pair'], {})[r['arm']] = r['ms']
arm = (sys.argv[2] if len(sys.argv) > 2 else 'b')
p = {k: v for k, v in p.items() if arm in v and 'off' in v}
for v in p.values():
    v['b'] = v[arm]
d = [(v['b'] - v['off']) / v['off'] * 100 for v in p.values()]
random.seed(1)
bs = sorted(st.median(random.choices(d, k=len(d))) for _ in range(10000))
print('pairs', len(d), 'off median ms', st.median(v['off'] for v in p.values()), 'b median ms', st.median(v['b'] for v in p.values()))
print('paired diffs %', [round(x, 1) for x in d])
print('median %.2f%% bootstrap 95%% CI [%.2f, %.2f]' % (st.median(d), bs[250], bs[9750]))
