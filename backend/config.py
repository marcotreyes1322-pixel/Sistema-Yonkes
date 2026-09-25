"""Runtime configuration, read from environment variables.

All settings have development-friendly defaults so `uvicorn backend.main:app`
works out of the box. Override them in production (see README).
"""

import logging
import os
import secrets
from pathlib import Path
from zoneinfo import ZoneInfo

log = logging.getLogger("yonkes")

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("DATA_DIR", ROOT_DIR / "data"))
FRONTEND_DIR = ROOT_DIR / "frontend"

# Hosts with an ephemeral disk (Render sets RENDER=true) would silently lose the
# SQLite file and a generated broker token on every deploy or restart: refuse to
# start instead of losing yonkes, access codes and payments.
if os.getenv("RENDER"):
    _missing = [v for v in ("DATABASE_URL", "BROKER_TOKEN") if not os.getenv(v, "").strip()]
    if _missing:
        raise RuntimeError(
            f"Falta configurar {', '.join(_missing)} en Render (Environment). "
            "Sin ellas los datos se borrarían en cada reinicio."
        )


def _database_url() -> str:
    """SQLite by default; PostgreSQL when DATABASE_URL points to one.

    Hosting providers (Render, Heroku...) hand out `postgres://` or `postgresql://`
    URLs; SQLAlchemy needs the driver spelled out to use psycopg 3.
    """
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        return f"sqlite:///{DATA_DIR / 'yonkes.db'}"
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url


DATABASE_URL = _database_url()

# Business timezone: decides what "today" means for subscription due dates.
APP_TZ = ZoneInfo(os.getenv("APP_TZ", "America/Mexico_City"))

# Seconds a freshly opened WebSocket has to send its auth message.
WS_AUTH_TIMEOUT = float(os.getenv("WS_AUTH_TIMEOUT", "10"))

# How often (seconds) connected yonkes are re-checked for lapsed subscriptions.
SUBSCRIPTION_SWEEP_SECONDS = float(os.getenv("SUBSCRIPTION_SWEEP_SECONDS", "60"))


def _load_broker_token() -> str:
    """BROKER_TOKEN env var, or a random token persisted in DATA_DIR on first run."""
    token = os.getenv("BROKER_TOKEN")
    if token:
        return token
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    token_file = DATA_DIR / "broker_token.txt"
    if token_file.exists():
        return token_file.read_text().strip()
    token = secrets.token_urlsafe(24)
    token_file.write_text(token)
    token_file.chmod(0o600)
    log.warning("BROKER_TOKEN not set; generated one and saved it to %s", token_file)
    return token


BROKER_TOKEN = _load_broker_token()
