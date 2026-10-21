"""Read-only boundaries use temporary databases and never query the user's data."""
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("zusage_readonly_test", ROOT / "zusage.py")
zusage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zusage)
rate_spec = importlib.util.spec_from_file_location("token_rate_readonly_test", ROOT / "token_rate.py")
token_rate = importlib.util.module_from_spec(rate_spec)
rate_spec.loader.exec_module(token_rate)


class ReadOnlyDatabaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name) / "usage.sqlite"
        with closing(sqlite3.connect(str(self.db))) as con, con:
            con.execute("create table model_usage (value text)")
            con.execute("insert into model_usage values ('fixture')")

    def connect(self):
        with mock.patch.object(zusage, "DB_PATH", self.db):
            return zusage.connect()

    def test_connection_rejects_writes_even_after_query_only_is_disabled(self):
        con = self.connect()
        self.addCleanup(con.close)
        self.assertEqual(con.execute("pragma query_only").fetchone()[0], 1)
        con.execute("pragma query_only=0")
        for sql in ("insert into model_usage values ('forbidden')", "create table forbidden (id int)"):
            with self.subTest(sql=sql), self.assertRaises(sqlite3.OperationalError):
                con.execute(sql)
        self.assertEqual(con.execute("select value from model_usage").fetchone()[0], "fixture")

    def test_readonly_connection_failure_never_retries_a_writable_handle(self):
        with mock.patch.object(zusage.sqlite3, "connect", side_effect=sqlite3.OperationalError("denied")) as connect:
            with self.assertRaises(sqlite3.OperationalError):
                self.connect()
        self.assertEqual(connect.call_count, 1)
        self.assertTrue(connect.call_args.kwargs["uri"])
        self.assertIn("mode=ro", connect.call_args.args[0])

    def test_missing_database_is_never_created(self):
        self.db.unlink()
        with self.assertRaises(sqlite3.OperationalError):
            self.connect()
        self.assertFalse(self.db.exists())

    def test_uri_metacharacters_in_filename_do_not_change_connection_options(self):
        target = self.db.with_name("用量 ?mode=rw&x=#.sqlite")
        self.db.rename(target)
        self.db = target
        con = self.connect()
        self.addCleanup(con.close)
        self.assertEqual(con.execute("select value from model_usage").fetchone()[0], "fixture")
        with self.assertRaises(sqlite3.OperationalError):
            con.execute("insert into model_usage values ('forbidden')")

    def test_rate_query_also_escapes_paths_and_enforces_readonly(self):
        target = self.db.with_name("rate ?mode=rw&x=#.sqlite")
        self.db.rename(target)
        with mock.patch.object(token_rate, "DB_PATH", str(target)):
            con = token_rate.open_db()
        self.assertIsNotNone(con)
        self.addCleanup(con.close)
        self.assertEqual(con.execute("pragma query_only").fetchone()[0], 1)
        con.execute("pragma query_only=0")
        with self.assertRaises(sqlite3.OperationalError):
            con.execute("insert into model_usage values ('forbidden')")

    def test_query_only_failure_closes_handle_and_never_fails_open(self):
        for module, function in ((zusage, zusage.connect), (token_rate, token_rate.open_db)):
            with self.subTest(module=module.__name__):
                con = mock.Mock()
                con.execute.side_effect = sqlite3.OperationalError("query_only failed")
                with mock.patch.object(module, "DB_PATH", self.db), \
                        mock.patch.object(module.sqlite3, "connect", return_value=con) as connect:
                    if module is zusage:
                        with self.assertRaises(sqlite3.OperationalError):
                            function()
                    else:
                        self.assertIsNone(function())
                con.close.assert_called_once()
                connect.assert_called_once()
