"""Run with: python -m unittest -v"""
from datetime import datetime, timezone
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from app import add_duration, create_app


HEADERS = {"X-Requested-With": "Minuteur"}


class TimerTests(unittest.TestCase):
    def setUp(self):
        self.storage = TemporaryDirectory()
        self.addCleanup(self.storage.cleanup)
        self.config = {"TESTING": True, "DATA_DIR": self.storage.name, "APP_PASSWORD": "",
                       "SECRET_KEY": "test-secret", "SESSION_COOKIE_SECURE": False}
        self.app = create_app(self.config)
        self.client = self.app.test_client()

    def post(self, path, body):
        return self.client.post(path, json=body, headers=HEADERS)

    def test_calendar_clamps_before_adding_days_and_time(self):
        values = dict(years=1, months=0, days=1, hours=2, minutes=3)
        start = datetime(2024, 2, 29, 12, tzinfo=timezone.utc)
        self.assertEqual(add_duration(start, values), datetime(2025, 3, 1, 14, 3, tzinfo=timezone.utc))
        values.update(years=0, months=1, days=0, hours=0, minutes=0)
        self.assertEqual(add_duration(datetime(2024, 1, 31, tzinfo=timezone.utc), values),
                         datetime(2024, 2, 29, tzinfo=timezone.utc))
        values.update(months=13)
        self.assertEqual(add_duration(datetime(2024, 1, 31, tzinfo=timezone.utc), values),
                         datetime(2025, 2, 28, tzinfo=timezone.utc))

    def test_timer_lifecycle_persists_across_app_restarts(self):
        before = datetime.now(timezone.utc)
        response = self.post("/api/timers", {"title": " Launch ", "minutes": 2})
        self.assertEqual(response.status_code, 201)
        timer = response.json["timer"]
        self.assertEqual(set(timer), {"id", "title", "created_at", "ends_at"})
        self.assertEqual(timer["title"], "Launch")
        end = datetime.fromisoformat(timer["ends_at"])
        self.assertAlmostEqual((end - before).total_seconds(), 120, delta=2)
        restarted = create_app(self.config).test_client()
        self.assertEqual(restarted.get("/api/timers").json["timers"], [timer])
        self.assertEqual(restarted.delete("/api/timers/" + timer["id"], json={}, headers=HEADERS).status_code, 204)
        self.assertEqual(self.client.get("/api/timers").json["timers"], [])
        self.assertEqual(self.client.delete("/api/timers/" + timer["id"], json={}, headers=HEADERS).status_code, 404)

    def test_fresh_database_uses_current_schema(self):
        with closing(sqlite3.connect(Path(self.storage.name) / "timers.sqlite3")) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(
                [row[1] for row in connection.execute("PRAGMA table_info(timers)")],
                ["id", "title", "created_at", "ends_at"],
            )

    def test_future_database_version_is_rejected_without_changes(self):
        timer = self.post("/api/timers", {"title": "Keep me", "minutes": 1}).json["timer"]
        path = Path(self.storage.name) / "timers.sqlite3"
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute("PRAGMA user_version=3")
            schema = connection.execute("SELECT sql FROM sqlite_master WHERE name='timers'").fetchone()[0]
        with self.assertRaisesRegex(RuntimeError, "newer application version"):
            create_app(self.config)
        with closing(sqlite3.connect(path)) as connection:
            connection.row_factory = sqlite3.Row
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertEqual(
                connection.execute("SELECT sql FROM sqlite_master WHERE name='timers'").fetchone()[0],
                schema,
            )
            self.assertEqual([dict(row) for row in connection.execute("SELECT * FROM timers")], [timer])

    def test_invalid_input_cannot_create_timers(self):
        cases = [[], {"title": "Empty"}, {"title": " ", "minutes": 1},
                 {"title": "Negative", "days": -1}, {"title": "Fraction", "hours": 1.5},
                 {"title": "Boolean", "minutes": True}, {"title": "Text", "minutes": "2"},
                 {"title": "Overflow", "years": 9999}]
        for body in cases:
            with self.subTest(body=body):
                self.assertEqual(self.post("/api/timers", body).status_code, 400)
        self.assertEqual(self.client.get("/api/timers").json["timers"], [])

    def test_authentication_guards_data_and_mutations(self):
        self.config["APP_PASSWORD"] = "private-password"
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.assertEqual(self.client.get("/api/session").json,
                         {"authenticated": False, "password_required": True})
        self.assertEqual(self.client.get("/api/timers").status_code, 401)
        self.assertEqual(self.post("/api/timers", {"title": "Secret", "minutes": 1}).status_code, 401)
        self.assertEqual(self.client.delete("/api/timers/missing", json={}, headers=HEADERS).status_code, 401)
        self.assertEqual(self.post("/api/login", {"password": "wrong"}).status_code, 401)
        self.assertEqual(self.post("/api/login", {"password": "private-password"}).status_code, 200)
        self.assertEqual(self.client.get("/api/timers").status_code, 200)
        self.assertEqual(self.post("/api/timers", {"title": "Secret", "minutes": 1}).status_code, 201)
        cookie = self.client.get_cookie("session")
        self.assertTrue(cookie.http_only)
        self.assertEqual(cookie.same_site, "Strict")
        restarted = create_app(self.config).test_client()
        restarted.set_cookie("session", cookie.value)
        self.assertEqual(restarted.get("/api/timers").status_code, 200)
        rotated = create_app({**self.config, "APP_PASSWORD": "changed"}).test_client()
        rotated.set_cookie("session", cookie.value)
        self.assertEqual(rotated.get("/api/timers").status_code, 401)
        self.assertEqual(self.post("/api/logout", {}).status_code, 200)
        self.assertEqual(self.client.get("/api/timers").status_code, 401)

    def test_cross_origin_form_mutations_are_rejected(self):
        self.assertEqual(self.client.post("/api/timers", json={"title": "Unwanted", "minutes": 1}).status_code, 403)
        self.assertEqual(self.client.post("/api/login", data={"password": "x"}, headers=HEADERS).status_code, 403)
        self.assertEqual(self.client.get("/api/timers").json["timers"], [])

    def test_failed_login_is_rate_limited(self):
        self.client = create_app({**self.config, "APP_PASSWORD": "secret"}).test_client()
        for _ in range(10):
            self.assertEqual(self.post("/api/login", {"password": "wrong"}).status_code, 401)
        blocked = self.post("/api/login", {"password": "secret"})
        self.assertEqual(blocked.status_code, 429)
        self.assertGreater(int(blocked.headers["Retry-After"]), 0)

    def test_generated_session_secret_survives_restart(self):
        config = {**self.config, "APP_PASSWORD": "secret", "SECRET_KEY": None}
        client = create_app(config).test_client()
        self.assertEqual(client.post("/api/login", json={"password": "secret"}, headers=HEADERS).status_code, 200)
        restarted = create_app(config).test_client()
        restarted.set_cookie("session", client.get_cookie("session").value)
        self.assertEqual(restarted.get("/api/timers").status_code, 200)


class LegacyMigrationTests(unittest.TestCase):
    VERSION = 0

    def setUp(self):
        self.storage = TemporaryDirectory()
        self.addCleanup(self.storage.cleanup)
        self.config = {"TESTING": True, "DATA_DIR": self.storage.name, "APP_PASSWORD": "",
                       "SECRET_KEY": "test-secret"}
        self.path = Path(self.storage.name) / "timers.sqlite3"
        units = ("years", "months", "days", "hours")
        if self.VERSION == 1:
            units += ("weeks",)
        self.timers = [
            dict(id=f"legacy-{unit}", title=f"Saved {unit}",
                 created_at="2024-02-29T12:34:56.789Z", ends_at="2030-03-31T23:59:00.123Z",
                 display_unit=unit)
            for unit in units
        ]
        self.expected = [{key: value for key, value in timer.items() if key != "display_unit"}
                         for timer in self.timers]
        allowed_units = ",".join(f"'{unit}'" for unit in units)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(f"""CREATE TABLE timers (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                ends_at TEXT NOT NULL,
                display_unit TEXT NOT NULL CHECK(display_unit IN ({allowed_units}))
            )""")
            connection.executemany(
                "INSERT INTO timers (id,title,created_at,ends_at,display_unit) VALUES (:id,:title,:created_at,:ends_at,:display_unit)",
                self.timers,
            )
            connection.execute(f"PRAGMA user_version={self.VERSION}")

    def test_legacy_timers_persist_across_migration_and_restarts(self):
        client = create_app(self.config).test_client()
        self.assertCountEqual(client.get("/api/timers").json["timers"], self.expected)
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(
                [row[1] for row in connection.execute("PRAGMA table_info(timers)")],
                ["id", "title", "created_at", "ends_at"],
            )

        created = client.post("/api/timers",
                              json={"title": "New timer", "days": 15},
                              headers=HEADERS)
        self.assertEqual(created.status_code, 201)
        self.assertEqual(set(created.json["timer"]), {"id", "title", "created_at", "ends_at"})
        expected = [*self.expected, created.json["timer"]]
        restarted = create_app(self.config).test_client()
        self.assertCountEqual(restarted.get("/api/timers").json["timers"], expected)

    def test_failed_migration_rolls_back_schema_and_all_timers(self):
        with closing(sqlite3.connect(self.path)) as connection:
            schema = connection.execute("SELECT sql FROM sqlite_master WHERE name='timers'").fetchone()[0]

        class FailingConnection(sqlite3.Connection):
            def execute(self, sql, *args, **kwargs):
                if sql == "PRAGMA user_version=2":
                    raise sqlite3.OperationalError("Injected migration failure")
                return super().execute(sql, *args, **kwargs)

        connection = sqlite3.connect(self.path, factory=FailingConnection)
        with patch("app.sqlite3.connect", return_value=connection):
            with self.assertRaisesRegex(sqlite3.OperationalError, "Injected migration failure"):
                create_app(self.config)

        with closing(sqlite3.connect(self.path)) as connection:
            connection.row_factory = sqlite3.Row
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], self.VERSION)
            self.assertEqual(
                connection.execute("SELECT sql FROM sqlite_master WHERE name='timers'").fetchone()[0],
                schema,
            )
            self.assertCountEqual(
                [dict(row) for row in connection.execute("SELECT * FROM timers")], self.timers
            )
            self.assertIsNone(connection.execute(
                "SELECT name FROM sqlite_master WHERE name='timers_next'"
            ).fetchone())
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE timers SET display_unit='invalid'")

        restarted = create_app(self.config).test_client()
        self.assertCountEqual(restarted.get("/api/timers").json["timers"], self.expected)


class VersionOneMigrationTests(LegacyMigrationTests):
    VERSION = 1


if __name__ == "__main__":
    unittest.main()
