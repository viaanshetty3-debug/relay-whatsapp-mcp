import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('transfer',Path(__file__).resolve().parents[1]/'scripts'/'transfer-termux-session.py')
transfer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)

class TransferTests(unittest.TestCase):
    def bundle(self,directory,registered=True,extra=None,credentials=None):
        directory=Path(directory)
        db=directory/'original.sqlite'
        connection=sqlite3.connect(db)
        connection.execute('CREATE TABLE chats(id TEXT)')
        connection.execute("INSERT INTO chats VALUES('preserved-chat')")
        connection.commit();connection.close()
        filename=directory/'session.tar.gz'
        with tarfile.open(filename,'w:gz') as archive:
            for name,data in [('auth/creds.json',json.dumps(credentials if credentials is not None else {'registered':registered,'me':{'id':'15550000000:1@s.whatsapp.net'}}).encode()),('auth/session-key.json',b'{"secret":"dummy-test-key"}'),('owner-token',b'test-owner-token-that-is-long-enough-12345\n')]:
                item=tarfile.TarInfo(name);item.size=len(data);archive.addfile(item,io.BytesIO(data))
            archive.add(db,arcname='bridge.sqlite')
            if extra is not None:archive.addfile(extra,io.BytesIO(b'x') if extra.isfile() else None)
        return filename

    def test_registered_session_token_and_database_survive_transfer(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'stage'
            token=transfer.extract_bundle(self.bundle(tmp),output)
            self.assertTrue(token.startswith('test-owner-token'))
            self.assertEqual((output/'auth'/'creds.json').stat().st_mode&0o777,0o600)
            self.assertEqual(output.stat().st_mode&0o777,0o700)
            connection=sqlite3.connect(output/'bridge.sqlite')
            self.assertEqual(connection.execute('SELECT id FROM chats').fetchone()[0],'preserved-chat');connection.close()

    def test_unregistered_sessions_are_not_activated(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError,'no completed pairing'):
                transfer.extract_bundle(self.bundle(tmp,registered=False),Path(tmp)/'stage')

    def test_path_traversal_and_links_are_rejected(self):
        for name,kind in [('../outside',tarfile.REGTYPE),('auth/../../outside',tarfile.REGTYPE),('auth/key.json',tarfile.SYMTYPE),('unrelated-private-file',tarfile.REGTYPE)]:
            with self.subTest(name=name,kind=kind),tempfile.TemporaryDirectory() as tmp:
                member=tarfile.TarInfo(name);member.type=kind;member.size=1 if kind==tarfile.REGTYPE else 0;member.linkname='/outside'
                with self.assertRaises(RuntimeError):
                    transfer.extract_bundle(self.bundle(tmp,extra=member),Path(tmp)/'stage')
                self.assertFalse((Path(tmp)/'outside').exists())

    def test_previous_mac_data_is_preserved_in_a_private_backup(self):
        old_root=transfer.ROOT
        try:
            with tempfile.TemporaryDirectory() as tmp:
                transfer.ROOT=Path(tmp)
                data=Path(tmp)/'data';data.mkdir();(data/'owner-token').write_text('previous-token')
                staged=Path(tmp)/'staged';staged.mkdir();(staged/'owner-token').write_text('imported-token')
                backup=transfer.activate_bundle(staged,Path(tmp)/'.migration-backups')
                self.assertEqual((backup/'owner-token').read_text(),'previous-token')
                self.assertEqual((data/'owner-token').read_text(),'imported-token')
                self.assertEqual(backup.parent.stat().st_mode&0o777,0o700)
        finally:transfer.ROOT=old_root

    def test_failed_activation_restores_the_previous_mac_data(self):
        old_root=transfer.ROOT
        try:
            with tempfile.TemporaryDirectory() as tmp:
                transfer.ROOT=Path(tmp)
                data=Path(tmp)/'data';data.mkdir();(data/'owner-token').write_text('previous-token')
                with self.assertRaises(FileNotFoundError):transfer.activate_bundle(Path(tmp)/'missing',Path(tmp)/'.migration-backups')
                self.assertEqual((data/'owner-token').read_text(),'previous-token')
        finally:transfer.ROOT=old_root

    def test_signed_qr_session_transfers_even_when_registered_flag_is_false(self):
        credentials={'registered':False,'me':{'id':'15550000000:1@s.whatsapp.net'},'account':{'accountSignature':{'type':'Buffer','data':[1,2]},'deviceSignature':{'type':'Buffer','data':[3,4]}}}
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'stage'
            transfer.extract_bundle(self.bundle(tmp,credentials=credentials),output)
            self.assertEqual(json.loads((output/'auth'/'creds.json').read_text()),credentials)

    def test_pending_phone_code_is_not_mistaken_for_completed_pairing(self):
        pending={'registered':False,'me':{'id':'15550000000@s.whatsapp.net','name':'~'},'pairingCode':'test-code'}
        self.assertFalse(transfer.has_linked_credentials(pending))
        pending['account']={'accountSignature':{'type':'Buffer','data':[]},'deviceSignature':{'type':'Buffer','data':[]}}
        self.assertFalse(transfer.has_linked_credentials(pending))
        self.assertFalse(transfer.has_linked_credentials({'registered':True}))

    def test_session_rejection_is_not_reported_as_a_network_problem(self):
        error=transfer.export_failure_message(40)
        self.assertIn('phone declined',error)
        self.assertNotIn('Wi-Fi',error)
        self.assertIn('SSH',transfer.export_failure_message(255))

    def test_database_snapshot_includes_wal_and_needs_no_sidecars(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'phone data #1.sqlite';snapshot=root/'snapshot.sqlite'
            connection=sqlite3.connect(source)
            try:
                connection.execute('PRAGMA journal_mode=WAL')
                connection.execute('PRAGMA wal_autocheckpoint=0')
                connection.execute('CREATE TABLE chats(id TEXT)')
                connection.execute("INSERT INTO chats VALUES('committed-in-wal')")
                connection.commit()
                self.assertTrue(Path(str(source)+'-wal').exists())
                transfer.snapshot_database(source,snapshot)
                transfer.validate_database(snapshot)
                received=sqlite3.connect(snapshot)
                try:
                    self.assertEqual(received.execute('PRAGMA journal_mode').fetchone()[0],'delete')
                    self.assertEqual(received.execute('SELECT id FROM chats').fetchone()[0],'committed-in-wal')
                finally:received.close()
                self.assertFalse(Path(str(snapshot)+'-wal').exists())
                self.assertEqual(snapshot.stat().st_mode&0o777,0o600)
            finally:connection.close()

    def test_remote_export_and_mac_import_preserve_a_real_wal_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)/'phone';data=home/'whatsapp-bridge'/'data';auth=data/'auth';auth.mkdir(parents=True)
            credentials={'registered':False,'me':{'id':'15550000000:1@s.whatsapp.net'},'account':{'accountSignature':{'type':'Buffer','data':[1,2]},'deviceSignature':{'type':'Buffer','data':[3,4]}}}
            (auth/'creds.json').write_text(json.dumps(credentials))
            (auth/'session-key.json').write_text('{"secret":"dummy-test-key"}')
            (data/'owner-token').write_text('test-owner-token-that-is-long-enough-12345')
            database=sqlite3.connect(data/'bridge.sqlite')
            try:
                database.execute('PRAGMA journal_mode=WAL')
                database.execute('CREATE TABLE chats(id TEXT)')
                database.execute("INSERT INTO chats VALUES('phone-history')");database.commit()
                archive=Path(tmp)/'received.tar.gz'
                with archive.open('wb') as output, mock.patch.object(Path,'home',return_value=home), mock.patch('subprocess.run',return_value=SimpleNamespace(stdout='',returncode=0)), mock.patch('socket.create_connection',side_effect=ConnectionRefusedError), mock.patch('sys.stdout',SimpleNamespace(buffer=output)), mock.patch('sys.stderr',io.StringIO()):
                    exec(compile(transfer.REMOTE_EXPORT,'phone-export','exec'),{})
                staged=Path(tmp)/'received'
                token=transfer.extract_bundle(archive,staged)
                self.assertTrue(token.startswith('test-owner-token'))
                imported=sqlite3.connect(staged/'bridge.sqlite')
                try:self.assertEqual(imported.execute('SELECT id FROM chats').fetchone()[0],'phone-history')
                finally:imported.close()
            finally:database.close()

    def test_missing_database_is_rejected_without_creating_an_empty_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing=Path(tmp)/'missing.sqlite'
            with self.assertRaisesRegex(RuntimeError,'no chat database'):transfer.validate_database(missing)
            self.assertFalse(missing.exists())

    def test_database_failures_identify_the_failing_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'source.sqlite';source.write_bytes(b'SQLite format 3\x00'+b'x'*100)
            with mock.patch('sqlite3.connect',side_effect=sqlite3.OperationalError('unable to open database file')):
                with self.assertRaisesRegex(RuntimeError,'Phone database export failed while opening'):
                    transfer.snapshot_database(source,Path(tmp)/'snapshot.sqlite')
                with self.assertRaisesRegex(RuntimeError,'Mac could not validate'):
                    transfer.validate_database(source)
        self.assertIn('database snapshot',transfer.export_failure_message(41))

    def test_remote_export_has_valid_python_syntax(self):
        compile(transfer.REMOTE_EXPORT,'phone-export','exec')

if __name__=='__main__':unittest.main()
