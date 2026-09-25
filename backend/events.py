"""Real-time side effects of business operations.

Both the WebSocket handlers and the REST API call these after committing to
the database, so every screen stays in sync no matter where a change came from.
"""

from sqlalchemy import select

from .database import SessionLocal
from .models import Request, Yonke
from .realtime import CLOSE_NO_SUBSCRIPTION, CLOSE_UNAUTHORIZED, manager
from .services import quote_to_dict, request_to_dict, today, yonke_to_dict

ACCESS_DENIED_SUBSCRIPTION = {
    "type": "access_denied",
    "reason": "subscription",
    "message": "Tu suscripción no está activa. Comunícate con el intermediario para renovarla.",
}
ACCESS_DENIED_TOKEN = {
    "type": "access_denied",
    "reason": "token",
    "message": "Tu código de acceso ya no es válido. Pide uno nuevo al intermediario.",
}


async def enforce_subscriptions(yonke_ids: list[int] | None = None) -> list[int]:
    """Kick any online yonke whose subscription lapsed. Returns ids that still have access."""
    ids = manager.online_yonke_ids() if yonke_ids is None else yonke_ids
    if not ids:
        return []
    with SessionLocal() as db:
        yonkes = db.scalars(select(Yonke).where(Yonke.id.in_(ids))).all()
    now = today()
    allowed = {y.id for y in yonkes if y.has_access(now)}
    kicked = False
    for yid in ids:
        if yid not in allowed:
            kicked |= await manager.disconnect_yonke(yid, CLOSE_NO_SUBSCRIPTION, ACCESS_DENIED_SUBSCRIPTION)
    if kicked:
        await manager.broadcast_presence()
    return sorted(allowed)


async def publish_request_created(req: Request, *, ref: str | None = None) -> int:
    """Broadcast a new request to every connected yonke with an active subscription."""
    eligible = await enforce_subscriptions()
    reached = await manager.broadcast_to_yonkes(
        {"type": "request.new", "request": {**request_to_dict(req), "my_quote": None}}, eligible
    )
    await manager.send_to_brokers(
        {
            "type": "request.created",
            "ref": ref,
            "request": {**request_to_dict(req), "quotes": []},
            "delivered_to": len(reached),
        }
    )
    return len(reached)


async def publish_request_closed(req: Request) -> None:
    await manager.broadcast_to_yonkes({"type": "request.closed", "request_id": req.id}, manager.online_yonke_ids())
    await manager.send_to_brokers({"type": "request.updated", "request": request_to_dict(req)})


async def publish_quote(quote, *, created: bool) -> None:
    await manager.send_to_brokers({"type": "quote.new" if created else "quote.updated", "quote": quote_to_dict(quote)})


async def publish_yonke_changed(yonke: Yonke, *, token_revoked: bool = False) -> None:
    """Tell brokers about the change and cut the yonke off if it lost access."""
    if token_revoked:
        await manager.disconnect_yonke(yonke.id, CLOSE_UNAUTHORIZED, ACCESS_DENIED_TOKEN)
    elif not yonke.has_access(today()):
        await manager.disconnect_yonke(yonke.id, CLOSE_NO_SUBSCRIPTION, ACCESS_DENIED_SUBSCRIPTION)
    await manager.send_to_brokers(
        {"type": "yonke.updated", "yonke": yonke_to_dict(yonke, online=manager.is_online(yonke.id))}
    )
    await manager.broadcast_presence()
