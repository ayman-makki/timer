# Minuteur

A responsive countdown app with a Flask backend and persistent SQLite storage. Timers are shared by everyone using the same instance; there are no separate user accounts or private timer lists.

## Local development

Requires Python 3.12.

```sh
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export APP_PASSWORD='choose-a-password'
flask --app app run --host 127.0.0.1 --port 8000
```

Open <http://localhost:8000>. The Flask development server is for local development only. Data defaults to `./data`; local cookies default to non-secure and proxy trust defaults to disabled. Environment variables must be exported for this command; the application does not require a dotenv loader.

**Without `APP_PASSWORD`, anyone who can reach the app can read, create, change and delete all timers.** Setting a password gates the shared instance, not individual timers.

Run the behavioral checks with `python -m unittest -v`. They cover calendar boundaries, SQLite persistence, validation, password sessions, and request protection.

## Docker

```sh
docker build -t minuteur .
docker volume create minuteur-data
docker run -d --name minuteur --restart unless-stopped \
  -p 8000:8000 \
  -v minuteur-data:/data \
  -e APP_PASSWORD='choose-a-password' \
  -e COOKIE_SECURE=false \
  minuteur
```

This example uses local HTTP. For production HTTPS, use `COOKIE_SECURE=true` (the image default) and place the app behind your trusted reverse proxy. The container runs as UID/GID `10001:10001`, using one Gunicorn worker with four threads, and checks `/healthz` with Python's standard library. Named volumes inherit the writable `/data` ownership. A host bind mount must be writable by UID 10001; do not solve permissions by running the app as root.

## Docker Compose

```sh
cp .env.example .env
# Edit .env: set APP_PASSWORD and use COOKIE_SECURE=true for HTTPS.
docker compose up -d --build
docker compose logs -f
```

Compose publishes host port 8000 and persists `/data` in the `sqlite-data` named volume. It defaults `COOKIE_SECURE` to `false` for local HTTP and enables proxy trust, matching the image's proxy setting. Compose reads `.env` for the password, optional session secret and cookie setting; its `TRUST_PROXY` value is explicitly `true` in `compose.yaml`. The `.env.example` proxy value instead documents the direct, non-proxied local development setting.

```sh
docker compose down
```

This keeps the data volume. **`docker compose down -v` deletes the volume and its timers.** Do not run multiple replicas; deploy one instance with one Gunicorn worker against the local SQLite volume.

## Coolify

1. Create an application from this repository and select the **Dockerfile** build pack, using `Dockerfile` at the repository root.
2. Set the application/container port to **8000** and configure your domain with HTTPS.
3. Add persistent volume storage mounted at **`/data`**. Ensure it is writable by UID/GID `10001:10001`.
4. Set `APP_PASSWORD` to a strong shared password. Set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
5. Deploy a single replica. `/healthz` is the unauthenticated health endpoint.

`SESSION_SECRET` is optional. If unset or empty, the app generates a secret in `/data/.session-secret`, preserving sessions across restarts. If provided, use a long random value (for example, generate one with `python -c 'import secrets; print(secrets.token_hex(32))'`) and keep it stable. Replacing the secret invalidates existing sessions.

### HTTPS and proxy trust

`COOKIE_SECURE=true` restricts session cookies to HTTPS; use `false` only for local HTTP. `TRUST_PROXY=true` trusts **exactly one proxy hop**, not an arbitrary chain. The proxy must overwrite forwarded headers and the application port must not be publicly reachable around it. Restrict direct access with your deployment network/firewall. If there is no proxy, set `TRUST_PROXY=false` (override it in `compose.yaml` when using Compose). If your deployment has multiple proxies, configure the edge/proxy topology to meet this one-hop contract rather than blindly trusting additional client-supplied headers.

## Countdown semantics

Year and month inputs are added as UTC calendar offsets, clamping the day to the last valid day of the target month (for example, January 31 plus one month becomes February 28, or February 29 in a leap year). Days, hours and minutes are then added. UTC calculation avoids daylight-saving changes affecting durations.

Each timer always displays four independent totals: years, months, weeks and days. Each is rounded down from the entire remaining duration; nothing is deducted between rows. A year is **365.2425 days**, a month is **365.2425 / 12 days**, a week is **7 days**, and a day is **24 hours**. Year/month totals are approximate fixed equivalents, not a fresh calendar calculation. Under one day, all totals are zero until the deadline is reached.

The red seven-segment display uses four vertically stacked rows on a dark background. Numbers are grouped with spaces (for example, `3 000 000`). Desktop shows two timer cards per row; mobile shows one. Existing timer names and deadlines are preserved automatically on upgrade; obsolete display preferences are removed.

The dashboard is reserved for timers. Use the header's **Nouveau minuteur** button or the final add-timer card to open the creation modal.

## Backups

SQLite can have active journal/WAL sidecar files. **Do not copy only the database file while the app is running.** Use SQLite's online backup API or the `sqlite3` shell's `.backup` command against the actual database file:

```sh
# Database: /data/timers.sqlite3 in Docker, ./data/timers.sqlite3 locally.
# Set DATABASE_PATH and an independent BACKUP_PATH before running.
sqlite3 "$DATABASE_PATH" ".backup '$BACKUP_PATH'"
```

Run this where the data volume is accessible and `sqlite3` is installed; the production image intentionally does not include the SQLite command-line tool. Store backups outside the live volume and also preserve `/data/.session-secret` securely if retaining sessions matters.

Alternatively, stop the container (`docker compose stop` or `docker stop minuteur`), copy the entire `/data` directory from its volume to independent storage, then start it again. Restore with the application stopped, preserving ownership for UID/GID 10001. Protect backups because they contain shared timer data and may include the session secret.
