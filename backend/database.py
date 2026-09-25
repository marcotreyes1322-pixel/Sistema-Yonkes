from collections.abc import Iterator

from sqlalchemy import Connection, create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DATA_DIR, DATABASE_URL

_is_sqlite = DATABASE_URL.startswith("sqlite")
if _is_sqlite:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    DATABASE_URL,
    # SQLite connections are used from FastAPI's threadpool and the event loop.
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    # Hosted Postgres drops idle connections; test each one before handing it out.
    pool_pre_ping=not _is_sqlite,
    pool_recycle=300 if not _is_sqlite else -1,
)

if _is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")  # enforce FK constraints like Postgres does
        cur.execute("PRAGMA journal_mode=WAL")  # readers don't block the writer
        cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per HTTP request."""
    with SessionLocal() as db:
        yield db


def migrate(conn: Connection) -> None:
    """Bring databases created by older versions up to date (create_all only adds tables).

    Idempotent: each step checks the current schema first. Works on SQLite and PostgreSQL.
    """
    columns = {c["name"] for c in inspect(conn).get_columns("requests")}
    if "selected_quote_id" not in columns:
        conn.execute(
            text(
                "ALTER TABLE requests ADD COLUMN selected_quote_id INTEGER "
                "CONSTRAINT fk_requests_selected_quote REFERENCES quotes(id) ON DELETE SET NULL"
            )
        )


def init_db() -> None:
    from . import models  # noqa: F401  (registers tables on Base.metadata)

    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        migrate(conn)
