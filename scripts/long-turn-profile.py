#!/usr/bin/env python3
# Long-turn profile of pi session files (plan 2026-11-21-long-turn-model-use, Phase 0).
# Usage: python3 scripts/long-turn-profile.py <sessions-dir>
# Counts tokens (input + cacheRead + cacheWrite + output) per turn and per step;
# a turn runs from one user message to the next. Steps whose tool calls are all
# read / bash / grep / find / ls / bulk_read are "mech"; any edit or write makes a
# step "edit". Cost is not used: claude-bridge reports cost 0 (subscription).
# Read-only: writes nothing.
import json, os, sys, collections, statistics
root = sys.argv[1]
MECH = {'read', 'bash', 'grep', 'find', 'ls', 'bulk_read'}
EDIT = {'edit', 'write'}
BUCKETS = [(1, 9, '1-9'), (10, 49, '10-49'), (50, 99, '50-99'), (100, 10**9, '100+')]
def bucket(n):
    for lo, hi, name in BUCKETS:
        if lo <= n <= hi: return name
    return '?'
turns = []  # dict per turn
sessions = {}
files = sorted(f for f in os.listdir(root) if f.endswith('.jsonl'))
for fn in files:
    cur = None
    sess = {'turns': 0, 'long': 0, 'tokens': 0, 'long_tokens': 0, 'max_steps': 0}
    compactions = 0
    with open(os.path.join(root, fn), encoding='utf-8', errors='replace') as fh:
        for line in fh:
            try: e = json.loads(line)
            except Exception: continue
            t = e.get('type')
            if t == 'compaction': compactions += 1
            if t != 'message': continue
            m = e.get('message') or {}
            role = m.get('role')
            if role == 'user':
                if cur: turns.append(cur)
                cur = {'file': fn, 'steps': [], 'compactions': compactions}
                continue
            if role != 'assistant' or cur is None: continue
            u = m.get('usage') or {}
            names = [c.get('name') for c in (m.get('content') or []) if isinstance(c, dict) and c.get('type') == 'toolCall']
            ctx = (u.get('input') or 0) + (u.get('cacheRead') or 0) + (u.get('cacheWrite') or 0)
            out = u.get('output') or 0
            if not names: kind = 'answer'
            elif any(n in EDIT for n in names): kind = 'edit'
            elif all(n in MECH for n in names): kind = 'mech'
            else: kind = 'other'
            cur['steps'].append({'model': f"{m.get('provider')}/{m.get('model')}", 'kind': kind,
                                 'ctx': ctx, 'out': out, 'cacheRead': u.get('cacheRead') or 0,
                                 'cacheWrite': u.get('cacheWrite') or 0, 'input': u.get('input') or 0,
                                 'cost': ((u.get('cost') or {}).get('total')) or 0,
                                 'tools': names})
    if cur: turns.append(cur)
    sessions[fn] = compactions
# Keep only turns with at least one step
turns = [t for t in turns if t['steps']]
for t in turns:
    t['n'] = len(t['steps'])
    t['tok'] = sum(s['ctx'] + s['out'] for s in t['steps'])
    t['models'] = collections.Counter(s['model'] for s in t['steps'])
    t['kinds'] = collections.Counter(s['kind'] for s in t['steps'])
total_tok = sum(t['tok'] for t in turns)
def summarize(sel, label):
    if not sel: return {'label': label, 'turns': 0}
    steps = sum(t['n'] for t in sel)
    kinds = collections.Counter()
    for t in sel: kinds.update(t['kinds'])
    tok = sum(t['tok'] for t in sel)
    cr = sum(s['cacheRead'] for t in sel for s in t['steps'])
    cw = sum(s['cacheWrite'] for t in sel for s in t['steps'])
    inp = sum(s['input'] for t in sel for s in t['steps'])
    mech_tok = sum(s['ctx'] + s['out'] for t in sel for s in t['steps'] if s['kind'] == 'mech')
    models = collections.Counter()
    for t in sel:
        for s in t['steps']: models[s['model']] += s['ctx'] + s['out']
    return {'label': label, 'turns': len(sel), 'steps': steps,
            'steps_per_turn_median': statistics.median(t['n'] for t in sel),
            'steps_per_turn_max': max(t['n'] for t in sel),
            'kind_share': {k: round(v / steps, 3) for k, v in kinds.items()},
            'token_share_of_all': round(tok / total_tok, 3) if total_tok else 0,
            'mech_token_share_within': round(mech_tok / tok, 3) if tok else 0,
            'cache_read_share': round(cr / (cr + cw + inp), 3) if (cr + cw + inp) else 0,
            'top_models_by_tokens': [(k, round(v / tok, 3)) for k, v in models.most_common(4)] if tok else []}
buckets = [summarize([t for t in turns if bucket(t['n']) == name], name) for _, _, name in BUCKETS]
long_turns = [t for t in turns if t['n'] >= 50]
long_files = sorted({t['file'] for t in long_turns})
result = {'files': len(files), 'turns': len(turns), 'total_tokens': total_tok,
          'buckets': buckets,
          'long_sessions': len(long_files),
          'long_turns_compactions': collections.Counter(min(t['compactions'], 3) for t in long_turns),
          'long_turn_examples': [(t['file'][:30], t['n'], round(t['tok'] / 1e6, 1), dict(t['models'].most_common(2))) for t in sorted(long_turns, key=lambda t: -t['n'])[:8]]}
# Per-step context growth inside long turns: median ctx at step 10, 50, 100
def ctx_at(k):
    vals = [t['steps'][k - 1]['ctx'] for t in long_turns if len(t['steps']) >= k]
    return (len(vals), int(statistics.median(vals)) if vals else None)
result['ctx_median_at_step'] = {k: ctx_at(k) for k in (1, 10, 50, 100)}
# Token share of the top 5% of turns
srt = sorted(turns, key=lambda t: -t['tok'])
top = srt[:max(1, len(srt) // 20)]
result['top5pct_turn_token_share'] = round(sum(t['tok'] for t in top) / total_tok, 3) if total_tok else 0
print(json.dumps(result, indent=1, default=str))
