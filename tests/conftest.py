import os
import tempfile

# Configure before the backend is imported: isolated DB, known broker token.
_tmp = tempfile.mkdtemp(prefix="yonkes-test-")
os.environ["DATA_DIR"] = _tmp
# Set TEST_DATABASE_URL=postgresql://... to run the suite against PostgreSQL.
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL", f"sqlite:///{_tmp}/test.db")
os.environ["BROKER_TOKEN"] = "test-broker-token"
os.environ["WS_AUTH_TIMEOUT"] = "2"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from backend.database import Base, engine  # noqa: E402
from backend.main import app  # noqa: E402

BROKER = {"Authorization": "Bearer test-broker-token"}


def _reset_database():
    if engine.dialect.name == "postgresql":
        # Also wipes tables left by older schema versions, which drop_all can't handle.
        with engine.begin() as conn:
            conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    else:
        Base.metadata.drop_all(engine)


@pytest.fixture()
def client():
    _reset_database()
    with TestClient(app) as c:  # runs lifespan -> init_db()
        yield c


@pytest.fixture()
def make_yonke(client):
    def _make(name="Yonke El Güero", phone="6621234567", months=1):
        r = client.post("/api/yonkes", json={"name": name, "phone": phone, "months": months}, headers=BROKER)
        assert r.status_code == 201, r.text
        return r.json()

    return _make
