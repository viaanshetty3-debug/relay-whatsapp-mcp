#!/usr/bin/env python3
"""Move this personal bridge from Termux using the user's existing SSH connection."""
import io
import inspect
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
# Set TERMUX_SSH_TARGET (user@host) and optionally TERMUX_SSH_PORT in the environment.
PHONE = os.environ.get('TERMUX_SSH_TARGET', '')
PHONE_PORT = os.environ.get('TERMUX_SSH_PORT', '8022')

def has_linked_credentials(credentials):
    """Recognize completed phone-code and signed QR pairings, not pending codes."""
    def has_bytes(value):
        if isinstance(value, (str, list)):
            return len(value) > 0
        return isinstance(value, dict) and value.get('type') == 'Buffer' and has_bytes(value.get('data'))
    if not isinstance(credentials, dict):
        return False
    me = credentials.get('me')
    if not isinstance(me, dict) or not isinstance(me.get('id'), str) or not me['id'].strip():
        return False
    account = credentials.get('account')
    signed = isinstance(account, dict) and has_bytes(account.get('accountSignature')) and has_bytes(account.get('deviceSignature'))
    return credentials.get('registered') is True or bool(signed)


def snapshot_database(source_path, destination_path):
    """Produce one complete database file, including committed WAL content."""
    source_path = Path(source_path).resolve()
    destination_path = Path(destination_path).resolve()
    if not source_path.is_file():
        raise RuntimeError('The phone database file is missing')
    source = None
    destination = None
    phase = 'opening the phone database'
    try:
        # Use native filesystem paths on both Android and macOS. SQLite URI
        # handling and read-only WAL initialization vary between their builds.
        source = sqlite3.connect(str(source_path), timeout=15)
        phase = 'creating the database snapshot'
        destination = sqlite3.connect(str(destination_path), timeout=15)
        source.backup(destination)
        phase = 'making the database snapshot self-contained'
        mode = destination.execute('PRAGMA journal_mode=DELETE').fetchone()[0]
        if mode.lower() != 'delete':
            raise RuntimeError('The database snapshot still requires journal sidecar files')
        destination.commit()
        destination_path.chmod(0o600)
    except sqlite3.Error as error:
        raise RuntimeError('Phone database export failed while '+phase+': '+str(error)) from error
    finally:
        if destination is not None:destination.close()
        if source is not None:source.close()


def validate_database(database_path):
    database_path = Path(database_path).resolve()
    if not database_path.is_file():
        raise RuntimeError('The transferred archive has no chat database; Mac data was not replaced')
    with database_path.open('rb') as incoming:
        if incoming.read(16) != b'SQLite format 3\x00':
            raise RuntimeError('The transferred chat database is incomplete or is not SQLite')
    connection = None
    try:
        connection = sqlite3.connect(str(database_path), timeout=15)
        if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('The transferred chat database failed its integrity check')
    except sqlite3.Error as error:
        raise RuntimeError('Mac could not validate the received database at '+str(database_path)+': '+str(error)) from error
    finally:
        if connection is not None:connection.close()


def export_failure_message(returncode):
    if returncode == 40:
        return 'The phone declined the export for the reason shown above. Mac data was not replaced.'
    if returncode == 41:
        return 'The phone could not create its database snapshot. Mac data was not replaced. Read the export error above.'
    if returncode == 255:
        return 'SSH could not complete. Check the SSH error above, the phone connection and your password. Mac data was not replaced.'
    return 'The phone export did not finish. Check its error above. Mac data was not replaced.'


# Executed on the phone. Only the encrypted SSH stream carries account credentials.
REMOTE_EXPORT = inspect.getsource(has_linked_credentials) + '\n' + inspect.getsource(snapshot_database) + '\n' + r'''
import io,json,os,signal,socket,sqlite3,subprocess,sys,tarfile,tempfile,time
from pathlib import Path
root=(Path.home()/'whatsapp-bridge').resolve()
data=root/'data'
def fail(message):
    print(message,file=sys.stderr)
    raise SystemExit(40)
creds=data/'auth'/'creds.json'
if not creds.is_file():
    fail('No saved WhatsApp session was found in the phone bridge data folder. Mac data was not changed.')
credentials=json.loads(creds.read_text())
if not has_linked_credentials(credentials):
    fail('The saved phone session has no completed pairing credentials. A pending phone code alone is not a linked session. Mac data was not changed.')
if (data/'auth-invalid').exists():
    fail('WhatsApp has rejected the saved phone session. It cannot be reused; link the Mac directly.')
if not (data/'owner-token').is_file() or not (data/'bridge.sqlite').is_file():
    fail('The phone bridge data is incomplete. No files were transferred.')
for item in [data/'owner-token',data/'bridge.sqlite',data/'auth',*list((data/'auth').rglob('*'))]:
    if item.is_symlink():fail('Refusing to export credentials through a symbolic link.')
# Stop only this project's Node process. SIGTERM flushes credentials and closes SQLite.
pids=[]
listing=subprocess.run(['ps','-eo','pid,args'],capture_output=True,text=True,check=True).stdout
for line in listing.splitlines():
    if 'src/main.js' not in line:continue
    try:
        pid=int(line.strip().split(None,1)[0])
        proc=Path('/proc')/str(pid)
        cwd=(proc/'cwd').resolve(strict=True)
        args=[a.decode() for a in (proc/'cmdline').read_bytes().split(b'\0') if a]
        if any((Path(arg) if arg.startswith('/') else cwd/arg).resolve()==root/'src'/'main.js' for arg in args[1:]):pids.append(pid)
    except (OSError,ValueError,UnicodeError):fail('Could not verify the phone bridge process. Stop the phone bridge manually and retry.')
for pid in pids:os.kill(pid,signal.SIGTERM)
for pid in pids:
    for attempt in range(200):
        try:os.kill(pid,0)
        except ProcessLookupError:break
        time.sleep(.05)
    else:fail('The phone bridge did not stop cleanly. Stop it manually and retry; no credentials were changed.')
try:
    connection=socket.create_connection(('127.0.0.1',8787),timeout=1)
except OSError:pass
else:
    connection.close()
    fail('A service is still listening on the phone bridge port. Stop the phone bridge manually before transferring.')
print('Phone bridge stopped; original phone credentials are preserved.',file=sys.stderr)
with tempfile.TemporaryDirectory(prefix='relay-transfer-') as tmp:
    snapshot=Path(tmp)/'bridge.sqlite'
    try:snapshot_database(data/'bridge.sqlite',snapshot)
    except Exception as error:
        print(str(error),file=sys.stderr)
        raise SystemExit(41)
    with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as archive:
        archive.add(data/'auth',arcname='auth')
        archive.add(data/'owner-token',arcname='owner-token')
        archive.add(snapshot,arcname='bridge.sqlite')
'''


def validate_configuration():
    # This migration is intentionally limited to the default personal data folder.
    env = ROOT / '.env'
    if env.exists():
        for line in env.read_text().splitlines():
            text = line.strip()
            if text and not text.startswith('#') and text.split('=', 1)[0].strip() in ('DATA_DIR', 'BRIDGE_TOKEN', 'PORT'):
                raise RuntimeError('The Mac uses custom data, login or port settings. Review .env before moving the default phone session.')


def extract_bundle(filename, destination):
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tarfile.open(filename, 'r:gz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if not path.parts or path.is_absolute() or '..' in path.parts or path.parts[0] not in ('auth', 'owner-token', 'bridge.sqlite'):
                raise RuntimeError('Unexpected path in the session archive')
            if path.parts[0] != 'auth' and len(path.parts) != 1:
                raise RuntimeError('Unexpected nested session file')
            target = destination.joinpath(*path.parts)
            if member.isdir():
                if path.parts[0] != 'auth':raise RuntimeError('Unexpected directory in the session archive')
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with archive.extractfile(member) as incoming, target.open('xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                target.chmod(0o600)
            else:
                raise RuntimeError('Links and special files are not allowed in a session archive')
    credentials = json.loads((destination/'auth'/'creds.json').read_text())
    if not has_linked_credentials(credentials):
        raise RuntimeError('The imported WhatsApp credentials have no completed pairing')
    token = (destination/'owner-token').read_text().strip()
    if len(token) < 32 or any(ch.isspace() for ch in token):
        raise RuntimeError('The imported owner token is invalid')
    validate_database(destination/'bridge.sqlite')
    return token


def local_listeners():
    result = subprocess.run(['/usr/sbin/lsof', '-t', '-iTCP:8787', '-sTCP:LISTEN'], capture_output=True, text=True)
    pids = sorted(set(int(line) for line in result.stdout.splitlines() if line.isdigit()))
    for pid in pids:
        cwd = subprocess.check_output(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True)
        paths = [line[1:] for line in cwd.splitlines() if line.startswith('n')]
        if not paths or Path(paths[0]).resolve() != ROOT:
            raise RuntimeError('Another application uses port 8787. It was not stopped; close it and retry.')
    return pids


def stop_local(pids):
    for pid in pids:
        try:os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:pass
    for unused in range(200):
        if not local_listeners():return
        time.sleep(.05)
    raise RuntimeError('The Mac bridge did not stop cleanly. No Mac data was replaced.')


def activate_bundle(staged, backup_root):
    data = ROOT/'data'
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = None
    if data.exists():
        backup = backup_root/('mac-before-transfer-'+time.strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid()))
        data.rename(backup)
    try:
        Path(staged).rename(data)
    except BaseException:
        if backup is not None and not data.exists():backup.rename(data)
        raise
    return backup


def start_local(token):
    environment = os.environ.copy()
    environment['AUTO_CONNECT'] = 'true'
    log = ROOT/'data'/'server.log'
    fd = os.open(str(log), os.O_WRONLY|os.O_CREAT|os.O_APPEND, 0o600)
    with os.fdopen(fd, 'ab') as stream:
        child = subprocess.Popen([str(ROOT/'start.sh')], cwd=str(ROOT), env=environment,
                                 stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                 start_new_session=True)
    for unused in range(60):
        if child.poll() is not None:
            raise RuntimeError('The credentials were imported, but the Mac bridge could not start. Its private log is data/server.log.')
        try:
            request = urllib.request.Request('http://127.0.0.1:8787/api/state', headers={'Authorization':'Bearer '+token})
            with urllib.request.urlopen(request, timeout=2) as response:state=json.load(response)
            if state['state']=='connected':return True
            if state['state']=='logged_out':
                raise RuntimeError('The files transferred, but WhatsApp rejected the saved session. Open the dashboard to pair the Mac again.')
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(.5)
    return False


def main():
    if not PHONE:
        raise SystemExit('Set TERMUX_SSH_TARGET=user@phone-ip (see .env.example) before transferring.')
    validate_configuration()
    local_listeners()  # Validate ownership before changing the phone or Mac.
    print('Transferring the linked WhatsApp session from your phone.')
    print('If SSH asks for a password, enter your Termux SSH password here. It is not stored.')
    backup_root = ROOT/'.migration-backups'
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    pending = backup_root/'pending-phone-session.tar.gz'
    with tempfile.TemporaryDirectory(prefix='.session-transfer-', dir=str(ROOT)) as temporary:
        temporary = Path(temporary)
        if pending.exists():
            print('Using the previously received private backup. Keep the phone bridge stopped.')
        else:
            archive = temporary/'session.tar.gz'
            descriptor = os.open(str(archive), os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as output:
                process = subprocess.run(['/usr/bin/ssh','-p',PHONE_PORT,'-o','ConnectTimeout=10',
                                          '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
                                          '-o','StrictHostKeyChecking=yes',PHONE,'python -'],
                                         input=REMOTE_EXPORT.encode(), stdout=output, check=False)
            if process.returncode:
                raise RuntimeError(export_failure_message(process.returncode))
            archive.rename(pending)
        staged = temporary/'data'
        try:
            token = extract_bundle(pending, staged)
        except Exception as error:
            raise RuntimeError(str(error)+'\nThe received phone backup is preserved privately at '+str(pending)+'. Mac data was not replaced.') from error
        stop_local(local_listeners())
        backup = activate_bundle(staged, backup_root)
        pending.rename(backup_root/('imported-phone-session-'+time.strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid())+'.tar.gz'))
    print('Phone session, owner token and chat database imported.')
    if backup:print('Previous Mac data backed up at: '+str(backup))
    print('The phone bridge has been stopped. Keep it stopped while using this session on your Mac.')
    connected = start_local(token)
    if connected:print('Verified: the Mac bridge is connected to WhatsApp using the transferred session.')
    else:print('Files transferred and the Mac bridge is running; WhatsApp is still connecting. Check its dashboard.')
    print('Dashboard: http://127.0.0.1:8787')
    print('Sign in with your original Termux bridge owner token.')


if __name__=='__main__':
    try:main()
    except (Exception, KeyboardInterrupt) as error:
        print('Transfer did not complete: '+str(error), file=sys.stderr)
        print('Original phone credentials are retained. No WhatsApp logout was performed.', file=sys.stderr)
        sys.exit(1)
