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

from backend.database import Base, engine  # noqa: E402
from backend.main import app  # noqa: E402

BROKER = {"Authorization": "Bearer test-broker-token"}


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    with TestClient(app) as c:  # runs lifespan -> init_db()
        yield c


@pytest.fixture()
def make_yonke(client):
    def _make(name="Yonke El Güero", phone="6621234567", months=1):
        r = client.post("/api/yonkes", json={"name": name, "phone": phone, "months": months}, headers=BROKER)
        assert r.status_code == 201, r.text
        return r.json()

    return _make
