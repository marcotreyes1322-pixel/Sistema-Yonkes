import contextlib
from datetime import date, timedelta

import pytest
from starlette.websockets import WebSocketDisconnect

from backend.services import add_months, today

from .conftest import BROKER


@contextlib.contextmanager
def connect(client, role, token):
    with client.websocket_connect(f"/ws/{role}") as ws:
        ws.send_json({"type": "auth", "token": token})
        yield ws


def expect_close(ws, code):
    """Server sends an access_denied event, then closes with `code`."""
    denied = ws.receive_json()
    assert denied["type"] == "access_denied"
    with pytest.raises(WebSocketDisconnect) as exc:
        ws.receive_json()
    assert exc.value.code == code
    return denied


def recv_until(ws, type_):
    """Skip unrelated events (e.g. presence) until a message of `type_` arrives."""
    for _ in range(20):
        msg = ws.receive_json()
        if msg["type"] == type_:
            return msg
    raise AssertionError(f"never received {type_}")


def test_broadcast_quote_roundtrip(client, make_yonke):
    y1, y2 = make_yonke("Yonke Uno"), make_yonke("Yonke Dos", "6629876543")

    with (
        connect(client, "broker", "test-broker-token") as broker,
        connect(client, "yonke", y1["access_token"]) as ws1,
        # Tokens are forgiving: lowercase and without dashes still work.
        connect(client, "yonke", y2["access_token"].lower().replace("-", "")) as ws2,
    ):
        assert broker.receive_json()["type"] == "hello"
        hello = ws1.receive_json()
        assert hello["type"] == "hello" and hello["yonke"]["name"] == "Yonke Uno" and hello["requests"] == []
        assert ws2.receive_json()["type"] == "hello"

        broker.send_json(
            {"type": "request.create", "ref": "a1", "vehicle_model": "Tsuru 2012", "part_name": "Alternador"}
        )
        created = recv_until(broker, "request.created")
        assert created["ref"] == "a1" and created["delivered_to"] == 2
        req_id = created["request"]["id"]
        for ws in (ws1, ws2):
            assert recv_until(ws, "request.new")["request"]["part_name"] == "Alternador"

        ws1.send_json(
            {
                "type": "quote.submit",
                "ref": "q1",
                "request_id": req_id,
                "condition": "good",
                "price": 1500,
                "notes": "con garantía",
            }
        )
        saved = recv_until(ws1, "quote.saved")
        assert saved["ref"] == "q1" and saved["quote"]["price"] == 1500
        assert "yonke" not in saved["quote"]  # yonkes never see who else quotes
        quote = recv_until(broker, "quote.new")["quote"]
        assert quote["yonke"]["name"] == "Yonke Uno" and quote["condition"] == "good"

        # Re-submitting updates the same quote instead of duplicating it.
        ws1.send_json({"type": "quote.submit", "request_id": req_id, "condition": "regular", "price": 1200})
        recv_until(ws1, "quote.saved")
        assert recv_until(broker, "quote.updated")["quote"]["id"] == quote["id"]

        # Invalid quote -> error, connection stays alive.
        ws2.send_json({"type": "quote.submit", "ref": "bad", "request_id": req_id, "condition": "good", "price": -5})
        err = recv_until(ws2, "error")
        assert err["ref"] == "bad" and "precio" in err["message"]
        ws2.send_text("not json")
        assert recv_until(ws2, "error")["message"]
        ws2.send_json({"type": "ping", "ref": "p"})
        assert recv_until(ws2, "pong")["ref"] == "p"

        # Closing the request removes it from yonkes and blocks new quotes.
        assert client.post(f"/api/requests/{req_id}/close", headers=BROKER).status_code == 200
        assert recv_until(ws2, "request.closed")["request_id"] == req_id
        ws2.send_json({"type": "quote.submit", "ref": "late", "request_id": req_id, "condition": "good", "price": 900})
        assert "cerrada" in recv_until(ws2, "error")["message"]

    history = client.get("/api/requests", headers=BROKER).json()
    assert history[0]["status"] == "closed" and len(history[0]["quotes"]) == 1
    assert history[0]["quotes"][0]["price"] == 1200


def test_snapshot_includes_my_quote(client, make_yonke):
    y = make_yonke()
    req = client.post(
        "/api/requests", json={"vehicle_model": "Jetta A4", "part_name": "Faro izq"}, headers=BROKER
    ).json()
    assert req["delivered_to"] == 0
    req_id = req["request"]["id"]

    with connect(client, "yonke", y["access_token"]) as ws:
        hello = ws.receive_json()
        assert [r["id"] for r in hello["requests"]] == [req_id]
        assert hello["requests"][0]["my_quote"] is None
        ws.send_json({"type": "quote.submit", "request_id": req_id, "condition": "bad", "price": 300})
        recv_until(ws, "quote.saved")

    with connect(client, "yonke", y["access_token"]) as ws:
        assert ws.receive_json()["requests"][0]["my_quote"]["price"] == 300


def test_invalid_tokens_are_rejected(client):
    with connect(client, "yonke", "AAAA-BBBB-CCCC") as ws:
        assert expect_close(ws, 4001)["reason"] == "token"
    with connect(client, "broker", "nope") as ws:
        expect_close(ws, 4001)

    # The first frame must be the auth message.
    with client.websocket_connect("/ws/yonke") as ws:
        ws.send_json({"type": "ping"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4001

    assert client.get("/api/yonkes").status_code == 401
    assert client.get("/api/yonkes", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_suspension_kicks_and_blocks(client, make_yonke):
    y = make_yonke()
    yid = y["yonke"]["id"]
    with connect(client, "broker", "test-broker-token") as broker:
        broker.receive_json()
        with connect(client, "yonke", y["access_token"]) as ws:
            ws.receive_json()
            assert recv_until(broker, "presence")["online"] == [yid]

            r = client.patch(f"/api/yonkes/{yid}", json={"subscription_status": "suspended"}, headers=BROKER)
            assert r.json()["has_access"] is False
            assert expect_close(ws, 4003)["reason"] == "subscription"
        assert recv_until(broker, "yonke.updated")["yonke"]["online"] is False

    # Reconnecting is refused while suspended...
    with connect(client, "yonke", y["access_token"]) as ws:
        expect_close(ws, 4003)

    # ...and works again once a payment reactivates the account (early payment
    # extends from the current due date).
    paid = client.post(f"/api/yonkes/{yid}/payments", json={"months": 1}, headers=BROKER).json()
    assert paid["subscription_status"] == "active" and paid["has_access"] is True
    assert paid["payment_due_date"] == add_months(add_months(today(), 1), 1).isoformat()
    with connect(client, "yonke", y["access_token"]) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_expired_subscription_is_not_broadcast(client, make_yonke):
    y = make_yonke()
    yid = y["yonke"]["id"]
    with connect(client, "yonke", y["access_token"]) as ws:
        ws.receive_json()
        yesterday = (today() - timedelta(days=1)).isoformat()
        client.patch(f"/api/yonkes/{yid}", json={"payment_due_date": yesterday}, headers=BROKER)
        expect_close(ws, 4003)

    r = client.post("/api/requests", json={"vehicle_model": "Aveo 2015", "part_name": "Puerta"}, headers=BROKER)
    assert r.json()["delivered_to"] == 0

    # Late payment restarts the period from today.
    paid = client.post(f"/api/yonkes/{yid}/payments", json={"months": 2}, headers=BROKER).json()
    assert paid["payment_due_date"] == add_months(today(), 2).isoformat()


def test_sweep_kicks_yonke_whose_period_ran_out(client, make_yonke):
    """A due date passing while connected (no API call) is caught by the sweeper."""
    from backend import events
    from backend.database import SessionLocal
    from backend.models import Yonke

    y = make_yonke()
    with connect(client, "yonke", y["access_token"]) as ws:
        ws.receive_json()
        with SessionLocal() as db:
            db.get(Yonke, y["yonke"]["id"]).payment_due_date = today() - timedelta(days=1)
            db.commit()
        client.portal.call(events.enforce_subscriptions)
        expect_close(ws, 4003)


def test_token_regeneration_revokes_old_devices(client, make_yonke):
    y = make_yonke()
    yid = y["yonke"]["id"]
    with connect(client, "yonke", y["access_token"]) as ws:
        ws.receive_json()
        new = client.post(f"/api/yonkes/{yid}/token", headers=BROKER).json()
        assert new["access_token"] != y["access_token"]
        assert new["activation_path"] == f"/recepcion/#token={new['access_token']}"
        assert expect_close(ws, 4001)["reason"] == "token"

    with connect(client, "yonke", y["access_token"]) as ws:
        expect_close(ws, 4001)
    with connect(client, "yonke", new["access_token"]) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_validation_on_rest(client, make_yonke):
    r = client.post("/api/yonkes", json={"name": " ", "phone": "123"}, headers=BROKER)
    assert r.status_code == 422
    r = client.post("/api/requests", json={"vehicle_model": "x", "part_name": "Motor"}, headers=BROKER)
    assert r.status_code == 422
    assert client.post("/api/yonkes/999/payments", json={}, headers=BROKER).status_code == 404
    assert client.post("/api/requests/999/close", headers=BROKER).status_code == 404
    y = make_yonke()
    listed = client.get("/api/yonkes", headers=BROKER).json()
    assert listed[0]["id"] == y["yonke"]["id"] and listed[0]["online"] is False
    assert "access_token" not in listed[0] and "access_token_hash" not in listed[0]


def test_add_months_clamps_end_of_month():
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)
    assert add_months(date(2026, 11, 15), 3) == date(2027, 2, 15)


def test_pwa_assets_served(client):
    for app_name in ("recepcion", "intermedio"):
        assert client.get(f"/{app_name}/").status_code == 200
        m = client.get(f"/{app_name}/manifest.webmanifest")
        assert m.status_code == 200 and m.headers["content-type"].startswith("application/manifest+json")
        assert client.get(f"/{app_name}/sw.js").status_code == 200
        for icon in m.json()["icons"]:
            assert client.get(icon["src"]).status_code == 200
    assert client.get("/", follow_redirects=False).headers["location"] == "/recepcion/"
