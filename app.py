"""Single-instance countdown service backed by SQLite."""
import calendar
from collections import OrderedDict
from contextlib import closing
from datetime import datetime, timedelta, timezone
from functools import wraps
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import uuid

from flask import Flask, g, jsonify, render_template, request, session
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.exceptions import HTTPException


UNITS = {"years", "months", "weeks", "days", "hours"}
DURATION_FIELDS = ("years", "months", "days", "hours", "minutes")


def add_duration(start, values):
    """Apply UTC calendar years/months together, clamp day, then add time."""
    month_index = start.year * 12 + start.month - 1 + values["years"] * 12 + values["months"]
    year, month = divmod(month_index, 12)
    month += 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return start.replace(year=year, month=month, day=day) + timedelta(
        days=values["days"], hours=values["hours"], minutes=values["minutes"]
    )


def create_app(config=None):
    app = Flask(__name__)
    app.config.update(
        DATA_DIR=os.environ.get("DATA_DIR", "data"),
        APP_PASSWORD=os.environ.get("APP_PASSWORD", ""),
        SECRET_KEY=os.environ.get("SESSION_SECRET") or None,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "false").lower() == "true",
        PERMANENT_SESSION_LIFETIME=timedelta(days=14),
        MAX_CONTENT_LENGTH=16 * 1024,
    )
    if config:
        app.config.update(config)
    if os.environ.get("TRUST_PROXY", "false").lower() == "true":
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=0, x_port=0, x_prefix=0)

    data_dir = Path(app.config["DATA_DIR"])
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not app.config["SECRET_KEY"]:
        secret_path = data_dir / ".session-secret"
        try:
            fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            app.config["SECRET_KEY"] = secret_path.read_text().strip()
            if not app.config["SECRET_KEY"]:
                raise RuntimeError("Stored session secret is empty")
        else:
            with os.fdopen(fd, "w") as stream:
                app.config["SECRET_KEY"] = secrets.token_hex(32)
                stream.write(app.config["SECRET_KEY"])

    database_path = data_dir / "timers.sqlite3"
    with closing(sqlite3.connect(database_path, timeout=10)) as initial_db:
        initial_db.execute("PRAGMA journal_mode=WAL")
        with initial_db:
            # Explicitly include schema changes in the transaction and serialize startups.
            initial_db.execute("BEGIN IMMEDIATE")
            version = initial_db.execute("PRAGMA user_version").fetchone()[0]
            if version > 1:
                raise RuntimeError("The timer database was created by a newer application version.")
            if version == 0:
                initial_db.execute("""CREATE TABLE timers_next (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    ends_at TEXT NOT NULL,
                    display_unit TEXT NOT NULL CHECK(display_unit IN ('years','months','weeks','days','hours'))
                )""")
                legacy_table = initial_db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='timers'"
                ).fetchone()
                if legacy_table:
                    initial_db.execute("""INSERT INTO timers_next (id,title,created_at,ends_at,display_unit)
                        SELECT id,title,created_at,ends_at,display_unit FROM timers""")
                    initial_db.execute("DROP TABLE timers")
                initial_db.execute("ALTER TABLE timers_next RENAME TO timers")
                initial_db.execute("PRAGMA user_version=1")
    database_path.chmod(0o600)

    password = app.config["APP_PASSWORD"]
    password_digest = hashlib.sha256(password.encode()).digest()
    password_version = hmac.new(
        app.config["SECRET_KEY"].encode(), password.encode(), hashlib.sha256
    ).hexdigest()
    attempts = OrderedDict()
    attempt_lock = threading.Lock()

    def database():
        if "database" not in g:
            g.database = sqlite3.connect(database_path, timeout=10)
            g.database.row_factory = sqlite3.Row
        return g.database

    @app.teardown_appcontext
    def close_database(_error):
        connection = g.pop("database", None)
        if connection is not None:
            connection.close()

    def authenticated():
        return not password or hmac.compare_digest(str(session.get("password_version", "")), password_version)

    def require_auth(handler):
        @wraps(handler)
        def protected(*args, **kwargs):
            if not authenticated():
                return jsonify(error="Please sign in to continue."), 401
            return handler(*args, **kwargs)
        return protected

    def json_body():
        body = request.get_json()
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object.")
        return body

    @app.before_request
    def protect_mutations():
        if request.path.startswith("/api/") and request.method in {"POST", "PATCH", "DELETE"}:
            # Cross-origin forms cannot send this header; no CORS is enabled.
            if request.headers.get("X-Requested-With") != "Minuteur" or not request.is_json:
                return jsonify(error="A same-origin JSON request is required."), 403

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        if request.path.startswith("/api/") or request.path == "/":
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        if request.path.startswith("/api/"):
            return jsonify(error=error.description), error.code
        return error

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def health():
        database().execute("SELECT id FROM timers LIMIT 1").fetchone()
        return jsonify(status="ok")

    @app.get("/api/session")
    def session_status():
        return jsonify(authenticated=authenticated(), password_required=bool(password))

    @app.post("/api/login")
    def login():
        try:
            supplied = json_body().get("password", "")
        except ValueError as error:
            return jsonify(error=str(error)), 400
        if not isinstance(supplied, str):
            return jsonify(error="Password must be text."), 400
        if not password:
            return jsonify(authenticated=True)
        peer = request.remote_addr or "unknown"
        now = time.monotonic()
        with attempt_lock:
            count, expires = attempts.get(peer, (0, now + 900))
            if now >= expires:
                count, expires = 0, now + 900
            if count >= 10:
                response = jsonify(error="Too many sign-in attempts. Try again in 15 minutes.")
                response.headers["Retry-After"] = str(max(1, int(expires - now)))
                return response, 429
            if not hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), password_digest):
                attempts[peer] = (count + 1, expires)
                attempts.move_to_end(peer)
                if len(attempts) > 1024:
                    attempts.popitem(last=False)
                return jsonify(error="Incorrect password."), 401
            attempts.pop(peer, None)
        session.clear()
        session.permanent = True
        session["password_version"] = password_version
        return jsonify(authenticated=True)

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(authenticated=not bool(password))

    @app.get("/api/timers")
    @require_auth
    def list_timers():
        rows = database().execute("SELECT * FROM timers ORDER BY created_at DESC, id").fetchall()
        return jsonify(timers=[dict(row) for row in rows])

    @app.post("/api/timers")
    @require_auth
    def create_timer():
        try:
            body = json_body()
            title = body.get("title", "")
            if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
                raise ValueError("Give your timer a name between 1 and 120 characters.")
            values = {field: body.get(field, 0) for field in DURATION_FIELDS}
            if any(type(value) is not int or value < 0 or value > 9999 for value in values.values()):
                raise ValueError("Duration fields must be whole numbers from 0 to 9999.")
            if not any(values.values()):
                raise ValueError("Choose a duration of at least one minute.")
            unit = body.get("display_unit", "years")
            if not isinstance(unit, str) or unit not in UNITS:
                raise ValueError("Choose years, months, weeks, days, or hours for the display.")
            now = datetime.now(timezone.utc)
            try:
                end = add_duration(now, values)
            except (ValueError, OverflowError):
                raise ValueError("This duration goes beyond the supported calendar (year 9999).") from None
        except ValueError as error:
            return jsonify(error=str(error)), 400
        timer = dict(id=uuid.uuid4().hex, title=title.strip(),
                     created_at=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                     ends_at=end.isoformat(timespec="milliseconds").replace("+00:00", "Z"), display_unit=unit)
        connection = database()
        with connection:
            connection.execute(
                "INSERT INTO timers (id,title,created_at,ends_at,display_unit) VALUES (:id,:title,:created_at,:ends_at,:display_unit)", timer
            )
        return jsonify(timer=timer), 201

    @app.patch("/api/timers/<timer_id>")
    @require_auth
    def update_timer(timer_id):
        try:
            body = json_body()
            unit = body.get("display_unit")
            if set(body) != {"display_unit"} or not isinstance(unit, str) or unit not in UNITS:
                raise ValueError("Supply a display_unit of years, months, weeks, days, or hours.")
        except ValueError as error:
            return jsonify(error=str(error)), 400
        connection = database()
        with connection:
            result = connection.execute("UPDATE timers SET display_unit=? WHERE id=?", (unit, timer_id))
            if not result.rowcount:
                return jsonify(error="Timer not found."), 404
            timer = connection.execute("SELECT * FROM timers WHERE id=?", (timer_id,)).fetchone()
        return jsonify(timer=dict(timer))

    @app.delete("/api/timers/<timer_id>")
    @require_auth
    def delete_timer(timer_id):
        connection = database()
        with connection:
            result = connection.execute("DELETE FROM timers WHERE id=?", (timer_id,))
        if not result.rowcount:
            return jsonify(error="Timer not found."), 404
        return "", 204

    return app


app = create_app()
