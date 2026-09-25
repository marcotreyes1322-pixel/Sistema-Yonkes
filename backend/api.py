"""REST API for the broker: yonke/subscription management and request history.

Every endpoint requires `Authorization: Bearer <BROKER_TOKEN>`.
"""

import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import events
from .config import BROKER_TOKEN
from .database import get_db
from .models import RequestStatus, SubscriptionStatus, Yonke
from .realtime import manager
from .schemas import PaymentIn, QuoteSelect, RequestCreate, YonkeCreate, YonkeUpdate
from .services import (
    DomainError,
    add_months,
    close_request,
    create_request,
    generate_access_token,
    hash_token,
    list_requests,
    request_to_dict,
    select_quote,
    today,
    yonke_to_dict,
)

log = logging.getLogger("yonkes.api")
_bearer = HTTPBearer(auto_error=False)


def is_broker_token(token: str | None) -> bool:
    return bool(token) and secrets.compare_digest(token.encode(), BROKER_TOKEN.encode())


def describe_wrong_token(token: str) -> str:
    """Log-safe hint about why a broker password failed (never logs the password)."""
    if token.strip() == BROKER_TOKEN:
        return "extra spaces"
    if token.lower() == BROKER_TOKEN.lower():
        return "only upper/lower case differs, e.g. keyboard auto-capitalization"
    return f"length {len(token)}, expected {len(BROKER_TOKEN)}"


def require_broker(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    if creds is None or not is_broker_token(creds.credentials):
        hint = describe_wrong_token(creds.credentials) if creds else "no Authorization header"
        client = request.client.host if request.client else "?"
        log.warning("REST %s %s from %s: wrong broker password (%s)", request.method, request.url.path, client, hint)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Contraseña de intermediario incorrecta")


router = APIRouter(prefix="/api", dependencies=[Depends(require_broker)])


def _get_yonke(db: Session, yonke_id: int) -> Yonke:
    yonke = db.get(Yonke, yonke_id)
    if yonke is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Yonke no encontrado")
    return yonke


def _with_new_token(db: Session, yonke: Yonke) -> str:
    """Assign a fresh token (retrying on the astronomically unlikely collision)."""
    for _ in range(5):
        token = generate_access_token()
        yonke.access_token_hash = hash_token(token)
        db.add(yonke)  # no-op if already persistent; re-adds after a rollback
        try:
            db.commit()
            return token
        except IntegrityError:
            db.rollback()
    raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "No se pudo generar el token")


def _credentials(yonke: Yonke, token: str) -> dict:
    # The plain token is only ever returned here; the DB keeps its hash.
    return {
        "yonke": yonke_to_dict(yonke, online=manager.is_online(yonke.id)),
        "access_token": token,
        "activation_path": f"/recepcion/#token={token}",
    }


# --- yonkes -----------------------------------------------------------------


@router.get("/yonkes")
def list_yonkes(db: Session = Depends(get_db)) -> list[dict]:
    yonkes = db.scalars(select(Yonke).order_by(Yonke.name)).all()
    return [yonke_to_dict(y, online=manager.is_online(y.id)) for y in yonkes]


@router.post("/yonkes", status_code=status.HTTP_201_CREATED)
async def create_yonke(data: YonkeCreate, db: Session = Depends(get_db)) -> dict:
    yonke = Yonke(
        name=data.name,
        phone=data.phone,
        subscription_status=SubscriptionStatus.ACTIVE,
        payment_due_date=add_months(today(), data.months),
    )
    token = _with_new_token(db, yonke)
    await events.publish_yonke_changed(yonke)
    return _credentials(yonke, token)


@router.patch("/yonkes/{yonke_id}")
async def update_yonke(yonke_id: int, data: YonkeUpdate, db: Session = Depends(get_db)) -> dict:
    yonke = _get_yonke(db, yonke_id)
    for key, value in data.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(yonke, key, value)
    db.commit()
    await events.publish_yonke_changed(yonke)
    return yonke_to_dict(yonke, online=manager.is_online(yonke.id))


@router.post("/yonkes/{yonke_id}/payments")
async def register_payment(yonke_id: int, data: PaymentIn, db: Session = Depends(get_db)) -> dict:
    """Extend the subscription N months and reactivate it.

    Paying early extends from the current due date; paying late starts from today
    (the unpaid gap is not charged, nor given back).
    """
    yonke = _get_yonke(db, yonke_id)
    yonke.payment_due_date = add_months(max(yonke.payment_due_date, today()), data.months)
    yonke.subscription_status = SubscriptionStatus.ACTIVE
    db.commit()
    await events.publish_yonke_changed(yonke)
    return yonke_to_dict(yonke, online=manager.is_online(yonke.id))


@router.post("/yonkes/{yonke_id}/token")
async def regenerate_token(yonke_id: int, db: Session = Depends(get_db)) -> dict:
    """Issue a new access token; devices using the old one are disconnected."""
    yonke = _get_yonke(db, yonke_id)
    token = _with_new_token(db, yonke)
    await events.publish_yonke_changed(yonke, token_revoked=True)
    return _credentials(yonke, token)


# --- requests ---------------------------------------------------------------


@router.get("/requests")
def get_requests(
    status_: RequestStatus | None = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[dict]:
    return [request_to_dict(r, with_quotes=True) for r in list_requests(db, status=status_, limit=limit)]


@router.post("/requests", status_code=status.HTTP_201_CREATED)
async def post_request(data: RequestCreate, db: Session = Depends(get_db)) -> dict:
    """Same as the broker's `request.create` WebSocket message (handy for bots/scripts)."""
    req = create_request(db, data)
    delivered = await events.publish_request_created(req)
    return {"request": request_to_dict(req), "delivered_to": delivered}


@router.post("/requests/{request_id}/select")
async def post_select_quote(request_id: int, data: QuoteSelect, db: Session = Depends(get_db)) -> dict:
    """Pick the winning quote: closes the request and notifies every yonke."""
    try:
        req, quote = select_quote(db, request_id, data.quote_id)
    except DomainError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    await events.publish_request_closed(req, winner=quote)
    return request_to_dict(req)


@router.post("/requests/{request_id}/close")
async def post_close_request(request_id: int, db: Session = Depends(get_db)) -> dict:
    try:
        req = close_request(db, request_id)
    except DomainError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    await events.publish_request_closed(req)
    return request_to_dict(req)
