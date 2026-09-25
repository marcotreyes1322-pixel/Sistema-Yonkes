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

# SQLite for now; swap for e.g. postgresql+psycopg://user:pass@host/db later.
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DATA_DIR / 'yonkes.db'}")

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
