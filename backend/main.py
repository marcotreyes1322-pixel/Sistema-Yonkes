"""FastAPI entry point: WebSocket endpoints, REST API and the two PWAs.

Run with:  uvicorn backend.main:app --reload

WebSocket protocol (JSON text frames, see README for the full reference):

  1. Client connects to /ws/yonke or /ws/broker.
  2. First message MUST be {"type": "auth", "token": "..."} within WS_AUTH_TIMEOUT
     seconds. Tokens travel inside the socket, never in the URL, so they don't
     end up in proxy/server access logs.
  3. Server answers {"type": "hello", ...} with the initial state, or closes with
       4001 -> invalid/revoked token (client should ask for a new one)
       4003 -> subscription inactive (client may retry later)
  4. Then both sides exchange typed messages. Every client message may carry a
     "ref" string that the server echoes back in its reply/error.
"""

import asyncio
import contextlib
import json
import logging
import mimetypes
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from sqlalchemy import select

from . import events
from .api import is_broker_token
from .api import router as api_router
from .config import FRONTEND_DIR, SUBSCRIPTION_SWEEP_SECONDS, WS_AUTH_TIMEOUT
from .database import SessionLocal, init_db
from .models import Yonke
from .realtime import CLOSE_NO_SUBSCRIPTION, CLOSE_UNAUTHORIZED, Client, manager
from .schemas import QuoteSubmit, RequestCreate
from .services import (
    DomainError,
    close_request,
    create_request,
    find_yonke_by_token,
    list_requests,
    open_requests_for_yonke,
    quote_to_dict,
    request_to_dict,
    submit_quote,
    today,
    yonke_to_dict,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("yonkes")

mimetypes.add_type("application/manifest+json", ".webmanifest")

FIELD_LABELS = {
    "vehicle_model": "vehículo",
    "part_name": "pieza",
    "condition": "condición",
    "price": "precio",
    "notes": "notas",
    "request_id": "solicitud",
}


async def _subscription_sweeper() -> None:
    """Periodically kick yonkes whose paid period ran out while connected."""
    while True:
        await asyncio.sleep(SUBSCRIPTION_SWEEP_SECONDS)
        try:
            await events.enforce_subscriptions()
        except Exception:
            log.exception("subscription sweep failed")


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_db()
    sweeper = asyncio.create_task(_subscription_sweeper())
    yield
    sweeper.cancel()


app = FastAPI(title="Sistema Yonkes", version="0.1.0", lifespan=lifespan)
app.include_router(api_router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


@app.get("/api/health", include_in_schema=False)
def health() -> dict:
    return {"ok": True, "online_yonkes": len(manager.online_yonke_ids())}


# --- WebSocket helpers ------------------------------------------------------


class BadMessage(Exception):
    pass


async def _receive(ws: WebSocket) -> dict:
    """Next JSON object from the socket. Raises WebSocketDisconnect when closed."""
    text = await ws.receive_text()
    try:
        msg = json.loads(text)
    except json.JSONDecodeError as e:
        raise BadMessage("Mensaje no es JSON válido") from e
    if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
        raise BadMessage("Mensaje sin 'type'")
    return msg


async def _read_auth_token(ws: WebSocket) -> str | None:
    """Wait for the {"type": "auth"} handshake. Closes the socket on failure."""
    try:
        msg = await asyncio.wait_for(_receive(ws), WS_AUTH_TIMEOUT)
    except (TimeoutError, BadMessage):
        await ws.close(CLOSE_UNAUTHORIZED)
        return None
    except WebSocketDisconnect:
        return None
    token = msg.get("token")
    if msg["type"] != "auth" or not isinstance(token, str) or not token:
        await ws.close(CLOSE_UNAUTHORIZED)
        return None
    return token


async def _deny(ws: WebSocket, code: int, message: dict) -> None:
    with contextlib.suppress(Exception):
        await ws.send_json(message)
        await ws.close(code)


def _validation_message(e: ValidationError) -> str:
    err = e.errors()[0]
    field = str(err["loc"][0]) if err.get("loc") else ""
    return f"Revisa el campo {FIELD_LABELS.get(field, field)}".strip()


async def _message_loop(ws: WebSocket, client: Client, handle) -> None:
    """Dispatch incoming messages to `handle(msg)` until the socket closes.

    Errors in a single message are reported back without dropping the connection.
    """
    while True:
        try:
            msg = await _receive(ws)
        except BadMessage as e:
            await client.send({"type": "error", "message": str(e)})
            continue
        ref = msg.get("ref") if isinstance(msg.get("ref"), str) else None
        if msg["type"] == "ping":
            await client.send({"type": "pong", "ref": ref})
            continue
        try:
            await handle(msg, ref)
        except ValidationError as e:
            await client.send({"type": "error", "ref": ref, "message": _validation_message(e)})
        except DomainError as e:
            await client.send({"type": "error", "ref": ref, "message": str(e)})


# --- /ws/yonke --------------------------------------------------------------


@app.websocket("/ws/yonke")
async def yonke_socket(ws: WebSocket) -> None:
    await ws.accept()
    token = await _read_auth_token(ws)
    if token is None:
        return

    with SessionLocal() as db:
        yonke = find_yonke_by_token(db, token)
    if yonke is None:
        return await _deny(ws, CLOSE_UNAUTHORIZED, events.ACCESS_DENIED_TOKEN)
    if not yonke.has_access(today()):
        return await _deny(ws, CLOSE_NO_SUBSCRIPTION, events.ACCESS_DENIED_SUBSCRIPTION)
    yonke_id = yonke.id

    client = Client(ws)
    # Holding the client's send lock while registering and building the snapshot
    # guarantees any broadcast racing with us is delivered *after* "hello", so the
    # client can never replace its list with a snapshot older than a live event.
    async with client.lock:
        came_online = manager.add_yonke(yonke_id, client)
        with SessionLocal() as db:
            snapshot = open_requests_for_yonke(db, yonke)
        await ws.send_json(
            {
                "type": "hello",
                "role": "yonke",
                "yonke": yonke_to_dict(yonke),
                "requests": snapshot,
            }
        )
    if came_online:
        await manager.broadcast_presence()

    async def handle(msg: dict, ref: str | None) -> None:
        if msg["type"] != "quote.submit":
            raise DomainError(f"Tipo de mensaje desconocido: {msg['type']}")
        data = QuoteSubmit.model_validate(msg)
        with SessionLocal() as db:
            # Re-check on every action: access may have been revoked since connecting.
            current = db.get(Yonke, yonke_id)
            if current is None or not current.has_access(today()):
                await manager.disconnect_yonke(yonke_id, CLOSE_NO_SUBSCRIPTION, events.ACCESS_DENIED_SUBSCRIPTION)
                await manager.broadcast_presence()
                return
            quote, created = submit_quote(db, current, data)
            yonke_view = quote_to_dict(quote, include_yonke=False)
            await events.publish_quote(quote, created=created)
        # Echo to all of this yonke's devices so the phone and the PC stay in sync.
        await manager.send_to_yonke(yonke_id, {"type": "quote.saved", "ref": ref, "quote": yonke_view})

    try:
        await _message_loop(ws, client, handle)
    except WebSocketDisconnect:
        pass
    finally:
        if manager.remove_yonke(yonke_id, client):
            await manager.broadcast_presence()


# --- /ws/broker -------------------------------------------------------------


@app.websocket("/ws/broker")
async def broker_socket(ws: WebSocket) -> None:
    await ws.accept()
    token = await _read_auth_token(ws)
    if token is None:
        return
    if not is_broker_token(token):
        return await _deny(
            ws, CLOSE_UNAUTHORIZED, {"type": "access_denied", "reason": "token", "message": "Token inválido"}
        )

    client = Client(ws)
    async with client.lock:  # same ordering guarantee as the yonke socket
        manager.add_broker(client)
        with SessionLocal() as db:
            requests = [request_to_dict(r, with_quotes=True) for r in list_requests(db, limit=100)]
            yonkes = [
                yonke_to_dict(y, online=manager.is_online(y.id)) for y in db.scalars(select(Yonke).order_by(Yonke.name))
            ]
        await ws.send_json(
            {
                "type": "hello",
                "role": "broker",
                "requests": requests,
                "yonkes": yonkes,
                "online": manager.online_yonke_ids(),
            }
        )

    async def handle(msg: dict, ref: str | None) -> None:
        if msg["type"] == "request.create":
            data = RequestCreate.model_validate(msg)
            with SessionLocal() as db:
                req = create_request(db, data)
            await events.publish_request_created(req, ref=ref)
        elif msg["type"] == "request.close":
            request_id = msg.get("request_id")
            if not isinstance(request_id, int):
                raise DomainError("Falta request_id")
            with SessionLocal() as db:
                req = close_request(db, request_id)
            await events.publish_request_closed(req)
        else:
            raise DomainError(f"Tipo de mensaje desconocido: {msg['type']}")

    try:
        await _message_loop(ws, client, handle)
    except WebSocketDisconnect:
        pass
    finally:
        manager.remove_broker(client)


# --- PWAs -------------------------------------------------------------------

app.mount("/recepcion", StaticFiles(directory=FRONTEND_DIR / "recepcion", html=True), name="recepcion")
app.mount("/intermedio", StaticFiles(directory=FRONTEND_DIR / "intermedio", html=True), name="intermedio")
app.mount("/shared", StaticFiles(directory=FRONTEND_DIR / "shared"), name="shared")


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    return RedirectResponse("/recepcion/")
