import argparse
import concurrent.futures
import datetime
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import time


KINDS = {'front': ('fronts', 'png', [2000, 2800]), 'mask': ('masks', 'webp', [1000, 1400]), 'foil': ('foils', 'webp', [1000, 1400])}


def image_header(data, extension):
    if extension == 'png':
        if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
            return {'headerError': 'Invalid or truncated PNG IHDR'}
        return {'dimensions': list(struct.unpack('>II', data[16:24])), 'bitDepth': data[24], 'colorType': data[25]}
    if len(data) < 25 or data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        return {'headerError': 'Invalid or truncated WebP RIFF'}
    offset = 12
    while offset + 8 <= len(data):
        kind = data[offset:offset + 4]
        length = int.from_bytes(data[offset + 4:offset + 8], 'little')
        body = data[offset + 8:offset + 8 + length]
        if kind == b'VP8X' and len(body) >= 10:
            return {'dimensions': [1 + int.from_bytes(body[4:7], 'little'), 1 + int.from_bytes(body[7:10], 'little')], 'headerKind': 'VP8X', 'alpha': bool(body[0] & 16), 'hasICC': bool(body[0] & 32), 'hasEXIF': bool(body[0] & 8), 'hasXMP': bool(body[0] & 4), 'animation': bool(body[0] & 2)}
        if kind == b'VP8L' and len(body) >= 5:
            packed = int.from_bytes(body[1:5], 'little')
            return {'dimensions': [(packed & 16383) + 1, ((packed >> 14) & 16383) + 1], 'headerKind': 'VP8L', 'alpha': bool((packed >> 28) & 1), 'hasICC': False}
        if kind == b'VP8 ' and len(body) >= 10:
            return {'dimensions': [int.from_bytes(body[6:8], 'little') & 16383, int.from_bytes(body[8:10], 'little') & 16383], 'headerKind': 'VP8', 'alpha': False, 'hasICC': False}
        offset += 8 + length + length % 2
    return {'headerError': 'Dimensions unavailable within bounded 64-byte prefix'}


def fetch(card_id, kind):
    directory, extension, dimensions = KINDS[kind]
    url = f'https://cdn.lil.org/nft/mi_note_cards/{directory}/{card_id}.{extension}'
    history = []
    for attempt in range(1, 4):
        result = subprocess.run(['curl', '-sS', '--range', '0-63', '--max-filesize', '1024', '--connect-timeout', '10', '--max-time', '25', '-D', '-', '-w', '\nCURL-META:%{http_code} %{size_download}\n', url], capture_output=True)
        content, _, tail = result.stdout.rpartition(b'\nCURL-META:')
        meta = tail.strip().split()
        status = int(meta[0]) if len(meta) >= 1 and meta[0].isdigit() else 0
        count = int(float(meta[1])) if len(meta) >= 2 else 0
        header_bytes, _, data = content.partition(b'\r\n\r\n')
        headers = {}
        for line in header_bytes.decode('latin-1').splitlines()[1:]:
            if ':' in line:
                name, value = line.split(':', 1)
                headers[name.lower()] = value.strip()
        entry = {'url': url, 'httpStatus': status, 'curlExit': result.returncode, 'attempts': attempt, 'downloadedBytes': count, 'contentType': headers.get('content-type'), 'contentRange': headers.get('content-range'), 'etag': headers.get('etag'), 'lastModified': headers.get('last-modified')}
        content_range = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', headers.get('content-range', ''))
        if content_range:
            entry['totalBytes'] = int(content_range.group(3))
        elif headers.get('content-length', '').isdigit():
            entry['totalBytes'] = int(headers['content-length'])
        if result.returncode == 0 and status in (200, 206):
            entry.update(image_header(data, extension))
        else:
            entry['error'] = result.stderr.decode('utf-8', errors='replace').strip()[:400] or f'HTTP {status}'
        errors = []
        if status not in (200, 206):
            errors.append(f'Unexpected HTTP {status}')
        if result.returncode:
            errors.append(f'curl exit {result.returncode}')
        if (entry.get('contentType') or '').split(';')[0] != f'image/{extension}':
            errors.append(f'Unexpected MIME {entry.get("contentType")}')
        if entry.get('dimensions') != dimensions:
            errors.append(f'Unexpected dimensions {entry.get("dimensions")}; expected {dimensions}')
        if not entry.get('totalBytes'):
            errors.append('Missing total byte length')
        if count > 64:
            errors.append(f'Range ignored: downloaded {count} bytes')
        entry['passed'] = not errors
        if errors:
            entry['anomalies'] = errors
        if history:
            entry['retryHistory'] = history.copy()
        if entry['passed'] or (status not in (0, 408, 425, 429, 500, 502, 503, 504) and result.returncode not in (6, 7, 18, 28, 35, 52, 55, 56)) or attempt == 3:
            return entry
        history.append({'attempt': attempt, 'httpStatus': status, 'curlExit': result.returncode, 'error': entry.get('error')})
        time.sleep(attempt)


def inspect_card(card_id):
    assets = {kind: fetch(card_id, kind) for kind in KINDS}
    return {'id': card_id, 'passed': all(asset['passed'] for asset in assets.values()), 'assets': assets}


def save(cards, complete, output, started_at):
    assets = [asset for card in cards for asset in card['assets'].values()]
    anomalies = [{'id': card['id'], 'kind': kind, 'url': asset['url'], 'anomalies': asset.get('anomalies', [])} for card in cards for kind, asset in card['assets'].items() if not asset['passed']]
    summary = {'cardsChecked': len(cards), 'cardsExpected': 1430, 'assetsChecked': len(assets), 'assetsPassed': sum(asset['passed'] for asset in assets), 'anomalyCount': len(anomalies), 'retriedAssetCount': sum(asset['attempts'] > 1 for asset in assets), 'downloadedHeaderBytesFinalAttempts': sum(asset['downloadedBytes'] for asset in assets), 'totalFrontAssetBytes': sum(card['assets']['front'].get('totalBytes', 0) for card in cards), 'totalAllAssetBytes': sum(asset.get('totalBytes', 0) for asset in assets)}
    document = {'startedAt': started_at, 'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'complete': complete, 'method': {'concurrency': 8, 'range': 'bytes=0-63', 'curlMaxFilesizeBytes': 1024, 'expectedFrontDimensions': [2000, 2800], 'expectedMaskFoilDimensions': [1000, 1400]}, 'summary': summary, 'anomalies': anomalies, 'cards': sorted(cards, key=lambda card: card['id'])}
    temporary = output.with_name(output.name + '.tmp')
    temporary.write_text(json.dumps(document, indent=2) + '\n')
    temporary.replace(output)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description='Check the first 64 bytes of all 4,290 Mi Note card assets')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    cards = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(inspect_card, card_id) for card_id in range(1, 1431)]
        for future in concurrent.futures.as_completed(futures):
            cards.append(future.result())
            if len(cards) == 50 or len(cards) % 250 == 0:
                print(json.dumps({'progress': save(cards, False, output, started_at)}), flush=True)
    summary = save(cards, True, output, started_at)
    print(json.dumps({'complete': summary, 'output': str(output)}), flush=True)
    return 0 if summary['assetsPassed'] == 4290 and summary['anomalyCount'] == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
