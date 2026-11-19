#!/usr/bin/env python3
"""Rebuild static sources on change and optionally run the local Worker."""
import argparse
import hashlib
import json
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE_DIRS = ('templates', 'static', 'content', 'data')


def source_state():
    paths = [ROOT / 'build.py', ROOT / '.pages.yml']
    for directory in SOURCE_DIRS:
        paths.extend(p for p in (ROOT / directory).rglob('*') if p.is_file())
    result = {}
    for path in paths:
        try:
            stat = path.stat()
            result[str(path)] = (stat.st_mtime_ns, stat.st_size)
        except FileNotFoundError:
            pass
    return result


def build():
    # build.py deliberately recreates dist/. Do that in an isolated staging copy:
    # deleting directories under Wrangler's active watcher can crash its asset scan.
    with tempfile.TemporaryDirectory(prefix='softnest-dev-build-') as directory:
        staging = Path(directory).resolve()
        shutil.copy2(ROOT / 'build.py', staging / 'build.py')
        for name in SOURCE_DIRS:
            shutil.copytree(ROOT / name, staging / name)
        result = subprocess.run([sys.executable, 'build.py'], cwd=staging,
                                capture_output=True, text=True)
        if result.returncode:
            print(result.stdout, end='')
            print(result.stderr, end='', file=sys.stderr)
            return False
        generated = staging / 'dist'
        target = ROOT / 'dist'
        if target.is_symlink() or target.resolve().parent != ROOT:
            raise RuntimeError('Preview output must be the workspace dist directory.')
        target.mkdir(exist_ok=True)
        expected = set()
        for source in generated.rglob('*'):
            if not source.is_file():
                continue
            relative = source.relative_to(generated)
            destination = target / relative
            if not destination.resolve().is_relative_to(target.resolve()):
                raise RuntimeError('Preview output path escaped dist.')
            expected.add(relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Avoid unnecessary reload events and keep watched directories stable.
            if not destination.exists() or destination.read_bytes() != source.read_bytes():
                shutil.copyfile(source, destination)
        for destination in target.rglob('*'):
            if destination.is_file() and destination.relative_to(target) not in expected:
                if not destination.resolve().is_relative_to(target.resolve()):
                    raise RuntimeError('Stale preview path escaped dist.')
                destination.unlink()
        print('Built local preview in dist/', flush=True)
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--watch-only', action='store_true', help='Only rebuild; run Wrangler separately.')
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--admin', action='store_true', help='Use isolated local administrator authentication (never production).')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    if not build():
        return 1
    worker = None
    if not args.watch_only:
        npx = shutil.which('npx.cmd') or shutil.which('npx')
        if not npx:
            parser.error('npx was not found. Install Node.js or use --watch-only.')
        command=[npx, 'wrangler', 'dev', '--local', '--ip', '127.0.0.1',
                 '--port', str(args.port), '--persist-to', str(ROOT / '.local/worker-state')]
        if args.admin:
            directory=ROOT / '.local/admin'
            directory.mkdir(parents=True, exist_ok=True)
            code=secrets.token_urlsafe(32)
            (directory / 'login-code.txt').write_text(code, encoding='utf-8')
            original=ROOT / '.dev.vars'
            settings=original.read_text(encoding='utf-8') if original.exists() else ''
            settings+='\nLOCAL_ADMIN_LOGIN_HASH="'+hashlib.sha256(code.encode()).hexdigest()+'"\n'
            settings+='LOCAL_ADMIN_SESSION_KEY="'+secrets.token_hex(32)+'"\n'
            settings+='LOCAL_ADMIN_ORIGIN="http://127.0.0.1:'+str(args.port)+'"\n'
            (directory / '.dev.vars').write_text(settings, encoding='utf-8')
            config=json.loads((ROOT / 'wrangler.jsonc').read_text(encoding='utf-8'))
            config['name']='softnest-local-admin'
            config['main']=str(ROOT / 'src/local-admin-worker.js')
            config['assets']['directory']=str(ROOT / 'dist')
            config.pop('triggers', None)
            config['d1_databases'][0]['migrations_dir']=str(ROOT / 'migrations')
            config_path=directory / 'wrangler.jsonc'
            config_path.write_text(json.dumps(config, indent=2), encoding='utf-8')
            command.extend(['--config', str(config_path)])
            print('Local administrator sign-in: /admin/products/login (code in .local/admin/login-code.txt)', flush=True)
        worker = subprocess.Popen(command, cwd=ROOT)
    print('Watching templates, static, content, data, build.py and .pages.yml. Ctrl+C stops.', flush=True)
    previous = source_state()
    try:
        while worker is None or worker.poll() is None:
            time.sleep(0.6)
            current = source_state()
            if current != previous:
                time.sleep(0.2)
                previous = source_state()
                if not build():
                    print('Build failed. Fix the source; the next edit will rebuild.', flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        if worker is not None and worker.poll() is None:
            worker.terminate()
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill()
    return worker.returncode if worker is not None and worker.returncode else 0


if __name__ == '__main__':
    raise SystemExit(main())
