"""Run with: python -m unittest -v"""
from datetime import datetime, timezone
from tempfile import TemporaryDirectory
import unittest

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
        response = self.post("/api/timers", {"title": " Launch ", "minutes": 2, "display_unit": "hours"})
        self.assertEqual(response.status_code, 201)
        timer = response.json["timer"]
        self.assertEqual(timer["title"], "Launch")
        end = datetime.fromisoformat(timer["ends_at"])
        self.assertAlmostEqual((end - before).total_seconds(), 120, delta=2)
        restarted = create_app(self.config).test_client()
        self.assertEqual(restarted.get("/api/timers").json["timers"], [timer])
        patched = restarted.patch("/api/timers/" + timer["id"], json={"display_unit": "months"}, headers=HEADERS)
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json["timer"]["ends_at"], timer["ends_at"])
        self.assertEqual(self.client.get("/api/timers").json["timers"][0]["display_unit"], "months")
        self.assertEqual(restarted.delete("/api/timers/" + timer["id"], json={}, headers=HEADERS).status_code, 204)
        self.assertEqual(self.client.get("/api/timers").json["timers"], [])
        self.assertEqual(self.client.delete("/api/timers/" + timer["id"], json={}, headers=HEADERS).status_code, 404)

    def test_invalid_input_cannot_create_timers(self):
        cases = [[], {"title": "Empty"}, {"title": " ", "minutes": 1},
                 {"title": "Negative", "days": -1}, {"title": "Fraction", "hours": 1.5},
                 {"title": "Boolean", "minutes": True}, {"title": "Text", "minutes": "2"},
                 {"title": "Overflow", "years": 9999}, {"title": "Units", "minutes": 1, "display_unit": []}]
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
        self.assertEqual(self.client.patch("/api/timers/missing", json={"display_unit": "days"}, headers=HEADERS).status_code, 401)
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


if __name__ == "__main__":
    unittest.main()
