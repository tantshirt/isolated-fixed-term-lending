"""Restore exact, public council references without resetting existing work."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
for source in json.loads((root / 'sources.lock.json').read_text()):
    target = root / 'vendor' / source['name']
    if target.exists():
        head = subprocess.check_output(['git', '-C', str(target), 'rev-parse', 'HEAD'], text=True).strip()
        if head != source['commit']:
            raise SystemExit(f'Refusing to replace changed checkout: {target}')
    else:
        target.mkdir(parents=True)
        subprocess.run(['git', 'init', str(target)], check=True)
        subprocess.run(['git', '-C', str(target), 'remote', 'add', 'origin', source['url']], check=True)
        subprocess.run(['git', '-C', str(target), 'fetch', '--depth', '1', 'origin', source['commit']], check=True)
        subprocess.run(['git', '-C', str(target), 'checkout', '--detach', 'FETCH_HEAD'], check=True)
    print(f"{source['name']}: {source['commit']}")
