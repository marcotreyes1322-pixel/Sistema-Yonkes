"""Business logic shared by the REST API and the WebSocket handlers."""

import calendar
import hashlib
import re
import secrets
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .config import APP_TZ
from .models import Quote, Request, RequestStatus, Yonke
from .schemas import QuoteSubmit, RequestCreate

# No I/O/0/1 so tokens can be read aloud and typed on a phone without mistakes.
_TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class DomainError(Exception):
    """A request that is well-formed but not allowed (closed request, etc.)."""


# --- time -------------------------------------------------------------------


def today() -> date:
    return datetime.now(APP_TZ).date()


def add_months(d: date, months: int) -> date:
    """Calendar-aware month addition: Jan 31 + 1 month -> Feb 28/29."""
    month_index = d.month - 1 + months
    year, month = d.year + month_index // 12, month_index % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def iso(dt: datetime) -> str:
    # SQLite hands back naive datetimes; everything we store is UTC.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# --- tokens -----------------------------------------------------------------


def generate_access_token() -> str:
    """12 chars from a 32-symbol alphabet (60 bits), formatted XXXX-XXXX-XXXX."""
    raw = "".join(secrets.choice(_TOKEN_ALPHABET) for _ in range(12))
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def hash_token(token: str) -> str:
    normalized = re.sub(r"[^A-Z0-9]", "", token.upper())
    return hashlib.sha256(normalized.encode()).hexdigest()


def find_yonke_by_token(db: Session, token: str) -> Yonke | None:
    if not token:
        return None
    return db.scalar(select(Yonke).where(Yonke.access_token_hash == hash_token(token)))


# --- serialization ----------------------------------------------------------


def yonke_to_dict(y: Yonke, *, online: bool | None = None) -> dict:
    d = {
        "id": y.id,
        "name": y.name,
        "phone": y.phone,
        "subscription_status": y.subscription_status.value,
        "payment_due_date": y.payment_due_date.isoformat(),
        "has_access": y.has_access(today()),
    }
    if online is not None:
        d["online"] = online
    return d


def quote_to_dict(q: Quote, *, include_yonke: bool = True) -> dict:
    d = {
        "id": q.id,
        "request_id": q.request_id,
        "condition": q.condition.value,
        "price": q.price,
        "notes": q.notes,
        "created_at": iso(q.created_at),
    }
    if include_yonke:
        # Only the broker sees who quoted; yonkes never see each other.
        d["yonke"] = {"id": q.yonke.id, "name": q.yonke.name, "phone": q.yonke.phone}
    return d


def request_to_dict(r: Request, *, with_quotes: bool = False) -> dict:
    d = {
        "id": r.id,
        "vehicle_model": r.vehicle_model,
        "part_name": r.part_name,
        "timestamp": iso(r.timestamp),
        "status": r.status.value,
    }
    if with_quotes:
        d["quotes"] = [quote_to_dict(q) for q in r.quotes]
    return d


# --- operations -------------------------------------------------------------


def create_request(db: Session, data: RequestCreate) -> Request:
    req = Request(vehicle_model=data.vehicle_model, part_name=data.part_name)
    db.add(req)
    db.commit()
    return req


def close_request(db: Session, request_id: int) -> Request:
    req = db.get(Request, request_id)
    if req is None:
        raise DomainError("La solicitud no existe")
    req.status = RequestStatus.CLOSED
    db.commit()
    return req


def submit_quote(db: Session, yonke: Yonke, data: QuoteSubmit) -> tuple[Quote, bool]:
    """Create or update this yonke's quote. Returns (quote, created)."""
    req = db.get(Request, data.request_id)
    if req is None:
        raise DomainError("La solicitud no existe")
    if req.status != RequestStatus.OPEN:
        raise DomainError("La solicitud ya fue cerrada")

    quote = db.scalar(select(Quote).where(Quote.request_id == req.id, Quote.yonke_id == yonke.id))
    created = quote is None
    if created:
        quote = Quote(request_id=req.id, yonke_id=yonke.id)
        db.add(quote)
    quote.condition = data.condition
    quote.price = data.price
    quote.notes = data.notes or None
    db.commit()
    db.refresh(quote)
    return quote, created


def list_requests(db: Session, *, status: RequestStatus | None = None, limit: int = 50) -> list[Request]:
    stmt = (
        select(Request)
        .options(selectinload(Request.quotes).selectinload(Quote.yonke))
        .order_by(Request.timestamp.desc(), Request.id.desc())
        .limit(limit)
    )
    if status is not None:
        stmt = stmt.where(Request.status == status)
    return list(db.scalars(stmt))


def open_requests_for_yonke(db: Session, yonke: Yonke, limit: int = 50) -> list[dict]:
    """Open requests plus this yonke's own quote on each (if any)."""
    reqs = list_requests(db, status=RequestStatus.OPEN, limit=limit)
    out = []
    for r in reqs:
        d = request_to_dict(r)
        mine = next((q for q in r.quotes if q.yonke_id == yonke.id), None)
        d["my_quote"] = quote_to_dict(mine, include_yonke=False) if mine else None
        out.append(d)
    return out
