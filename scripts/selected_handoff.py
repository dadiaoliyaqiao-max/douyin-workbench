"""Management-only v2 single-reference handoff. No browser or business generation.
Fail closed; original v1 batch state is never changed. Outputs are exclusive-create.
"""
import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def inside(root, path):
    resolved = (root / path).resolve()
    require(resolved.is_relative_to(root.resolve()), 'path outside workspace')
    return resolved


def gather(root, source, request, review, business):
    manifest = {}

    def raw(path, expected=None):
        p = inside(root, path)
        data = p.read_bytes()
        require(bool(data), f'empty source: {p.name}')
        sha = digest(data)
        require(expected is None or sha == expected, f'asset hash mismatch: {p.name}')
        manifest[p.relative_to(root.resolve()).as_posix()] = sha
        return data

    def load(path):
        return json.loads(raw(path))

    src = inside(root, source)
    req, rev, biz = load(request), load(review), load(business)
    inp, check, evidence = [load(src / name) for name in ('handoff-input.json', 'deep-check.json', 'evidence.json')]
    raw(src / 'card.md')
    vid, batch_id = req['video_id'], req['batch_id']
    require(req.get('user_request') and req.get('user_choice'), 'missing direct user confirmation')
    require(rev.get('approved_for_original_reference') is True and rev.get('reviewed_by') == 'controller', 'manager acceptance required')
    require(rev.get('video_id') == vid and rev.get('batch_id') == batch_id, 'review identity mismatch')
    require(rev.get('limitations') and rev.get('excluded_material'), 'explicit fact boundaries required')
    require(inp['user_selected_video_id'] == check['video_id'] == evidence['mapping']['video_id'] == vid, 'selected identity mismatch')
    require(inp['source_batch_id'] == evidence['source_batch_id'] == batch_id, 'source batch mismatch')
    require(inp['verification'].get('sufficient_for_original_reference') is True, 'producer reference insufficient')
    require(check.get('passed') is True and check['assessment'].get('structure_content_verified_enough_for_original') is True, 'deep check failed')
    require(check.get('checks') and all(v is True for v in check['checks'].values()), 'deep check contains failure')
    for key in ('verified_problem', 'verified_solution_points', 'transferable_mechanisms', 'do_not_copy', 'fact_boundary'):
        require(bool(inp.get(key)), f'missing reference field: {key}')
    comments = inp['comment_needs']
    require(comments['sample_size'] >= 30 and 0 <= comments['low_information'] <= comments['sample_size'] / 2, 'comment sample insufficient')
    require(comments.get('sampled_at') and comments.get('excerpts'), 'comment provenance missing')
    batch_dir = inside(root, Path('batches') / batch_id)
    batch = load(batch_dir / 'batch.json')
    mapping = evidence['mapping']
    require(mapping['category'] in ('benchmark', 'home'), 'this adapter supports benchmark/home selected references only')
    require(mapping['url'] == f'https://www.douyin.com/video/{vid}', 'source URL mismatch')
    published = datetime.fromisoformat(mapping['published_at'])
    start = datetime.fromisoformat(batch['window_start']).replace(tzinfo=published.tzinfo)
    end = datetime.fromisoformat(batch['window_end'])
    require(start <= published <= end, 'reference outside frozen window')
    if mapping['category'] == 'benchmark':
        require(any(a.get('account_id') == mapping['account_id'] and a.get('status') == 'confirmed' for a in batch['confirmed_benchmarks']), 'benchmark not confirmed')
    raw(batch_dir / evidence['cover']['file'], evidence['cover']['sha256'])
    reps = evidence['representative_frames']
    require(len(reps) >= 3, 'opening/body/ending evidence missing')
    for frame in reps:
        raw(src / frame['file'], frame['sha256'])
    frames = evidence['dense_observation']['frames']
    times = [f['actual'] for f in frames]
    duration = evidence['video']['duration_seconds']
    require(len(times) >= 3 and times == sorted(set(times)), 'invalid observation ordering')
    require(times[0] <= 2 and duration - 2 <= times[-1] <= duration, 'missing opening/ending coverage')
    require(max(b-a for a, b in zip(times, times[1:])) <= 3, 'large visual sampling gap')
    for frame in frames:
        require(abs(frame['actual'] - frame['seconds']) <= 0.5, 'media time mismatch')
        raw(src / frame['path'].replace('\\', '/'), frame['sha256'])
    # Do not propagate dense subtitle sequences, full transcripts, or AI transcript attachments.
    reference = {k: inp[k] for k in ('verification', 'verified_problem', 'verified_solution_points', 'comment_needs', 'transferable_mechanisms', 'do_not_copy', 'fact_boundary')}
    reference['mapping'] = mapping
    selection = {'schema_version': 2, 'scope': 'selected_reference_only', 'batch_id': batch_id,
                 'video_ids': [vid], 'user_request': req['user_request'], 'user_choice': req['user_choice'],
                 'confirmation_record': str(inside(root, request).relative_to(root.resolve())).replace('\\', '/')}
    return {'selection': selection, 'reference': reference, 'manager_review': rev,
            'business_profile': biz, 'manifest': manifest}


def status(root, directory, expected_hash=None):
    d = inside(root, directory)
    try:
        data = (d / 'handoff.json').read_bytes()
        seal = json.loads((d / 'seal.json').read_bytes())
        require(digest(data) == seal['handoff_sha256'], 'handoff changed')
        require(expected_hash is None or digest(data) == expected_hash, 'dispatch-pinned hash mismatch')
        handoff = json.loads(data)
        require(handoff['schema_version'] == 2, 'unsupported handoff schema')
        require(digest((d / 'selection.json').read_bytes()) == seal['selection_sha256'], 'selection changed')
        selection = json.loads((d / 'selection.json').read_bytes())
        require(selection == handoff['payload']['selection'], 'selection/handoff mismatch')
        current = gather(root, **handoff['inputs'])
        require(current == handoff['payload'], 'source_changed')
        return {'valid': True, 'delivery_complete': True, 'handoff': 'ready_for_session3',
                'scope': 'selected_reference_only', 'video_ids': selection['video_ids'],
                'handoff_sha256': digest(data), 'original_batch_revalidated': False}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {'valid': False, 'delivery_complete': False, 'handoff': 'handoff_error', 'error': str(exc)}


def create(root, directory, **inputs):
    payload = gather(root, **inputs)
    d = inside(root, directory)
    # Reserve a new directory only after validation; a partial write is never ready.
    d.mkdir(parents=True, exist_ok=False)
    handoff = {'schema_version': 2, 'created_at': datetime.now().astimezone().isoformat(),
               'inputs': inputs, 'payload': payload}
    selection_bytes, handoff_bytes = encode(payload['selection']), encode(handoff)
    for name, data in (('selection.json', selection_bytes), ('handoff.json', handoff_bytes)):
        with (d / name).open('xb') as f:
            f.write(data)
    require(gather(root, **inputs) == payload, 'source changed during sealing; leave incomplete directory for audit')
    with (d / 'seal.json').open('xb') as f:
        f.write(encode({'selection_sha256': digest(selection_bytes), 'handoff_sha256': digest(handoff_bytes)}))
    result = status(root, directory, digest(handoff_bytes))
    require(result['valid'], result.get('error', 'handoff validation failed'))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'status'])
    parser.add_argument('directory')
    for option in ('source', 'request', 'review', 'business', 'expected-hash'):
        parser.add_argument('--' + option)
    args = parser.parse_args()
    if args.action == 'create':
        values = {k: getattr(args, k) for k in ('source', 'request', 'review', 'business')}
        require(all(values.values()), 'create requires source/request/review/business')
        result = create(ROOT, args.directory, **values)
    else:
        result = status(ROOT, args.directory, args.expected_hash)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['valid'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
