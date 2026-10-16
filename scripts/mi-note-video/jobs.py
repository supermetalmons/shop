import hashlib
import json
from pathlib import Path
import re
import uuid
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONTRACT = json.loads((HERE / 'contract.json').read_text())


def now():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def job_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value):
        raise ValueError('Job names must contain 1–64 lowercase letters, digits, or hyphens.')
    return value


def catalog_count(root=ROOT):
    source = (Path(root) / 'src/lib/miNoteCards.ts').read_text()
    match = re.search(r'export const MI_NOTE_CARD_COUNT = (\d+);', source)
    if not match:
        raise ValueError('The current card catalog count could not be identified.')
    return int(match.group(1))


def select_ids(ids=None, all_cards=False, count=None):
    count = catalog_count() if count is None else count
    if bool(ids) == bool(all_cards):
        raise ValueError('Choose either --ids or --all; no collection is selected implicitly.')
    if all_cards:
        return list(range(1, count + 1))
    values = ids.split(',') if isinstance(ids, str) else ids
    try:
        result = [int(value) for value in values]
    except (ValueError, TypeError):
        raise ValueError('Card IDs must be comma-separated integers.') from None
    if not result or len(set(result)) != len(result) or any(value < 1 or value > count for value in result):
        raise ValueError(f'Choose distinct card IDs from 1 through {count}.')
    return sorted(result)


def create_job(name, ids, profile, motion, prepared, config):
    job_name(name)
    if profile not in CONTRACT['profiles'] or motion not in CONTRACT['motions']:
        raise ValueError('Unknown capture profile or motion.')
    root = config['guestRoot'].rstrip('/') + '/jobs/' + name
    return {
        'version': 1, 'jobId': str(uuid.uuid4()), 'name': name,
        'ids': select_ids(ids, count=prepared['catalogCount']), 'catalogCount': prepared['catalogCount'], 'profile': profile, 'motion': motion,
        'sourceId': prepared['sourceId'], 'sourceRoot': prepared['guestSourceRoot'],
        'root': root, 'python': config['python'], 'node': config['node'],
        'runtime': prepared['runtime'], 'contractSha256': hashlib.sha256((HERE / 'contract.json').read_bytes()).hexdigest(),
        'createdAt': now(),
    }


def validate_job(job):
    if job.get('version') != 1:
        raise ValueError('Unsupported job version.')
    job_name(job['name'])
    uuid.UUID(job['jobId'])
    if job['profile'] not in CONTRACT['profiles'] or job['motion'] not in CONTRACT['motions']:
        raise ValueError('Unknown capture profile or motion.')
    if type(job.get('catalogCount')) is not int or job['catalogCount'] < 1:
        raise ValueError('Invalid pinned catalog count.')
    if not job['ids'] or job['ids'] != sorted(set(job['ids'])) or any(type(value) is not int or value < 1 or value > job['catalogCount'] for value in job['ids']):
        raise ValueError('Invalid immutable card list.')
    if not re.fullmatch('[a-f0-9]{64}', job['sourceId']):
        raise ValueError('Invalid source snapshot identity.')
    for field in ('root', 'sourceRoot', 'python', 'node'):
        path = Path(job[field])
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError('Job paths must be absolute guest paths.')
    return job
