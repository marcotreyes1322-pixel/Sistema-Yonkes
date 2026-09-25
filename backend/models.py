"""SQLAlchemy models.

Portable across SQLite and PostgreSQL: enums are stored as VARCHAR + CHECK
constraint (no native PG enum types to migrate), and timestamps are UTC.
"""

import enum
from datetime import date, datetime, timezone

from sqlalchemy import (
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _str_enum(cls: type[enum.Enum], name: str) -> Enum:
    return Enum(
        cls,
        name=name,
        native_enum=False,
        create_constraint=True,
        length=16,
        values_callable=lambda e: [m.value for m in e],
    )


class SubscriptionStatus(str, enum.Enum):
    ACTIVE = "active"
    SUSPENDED = "suspended"  # manually cut off by the broker (e.g. didn't pay)


class RequestStatus(str, enum.Enum):
    OPEN = "open"  # accepting quotes
    CLOSED = "closed"  # broker found the part or gave up


class PartCondition(str, enum.Enum):
    GOOD = "good"
    REGULAR = "regular"
    BAD = "bad"


class Yonke(Base):
    __tablename__ = "yonkes"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(30))
    subscription_status: Mapped[SubscriptionStatus] = mapped_column(
        _str_enum(SubscriptionStatus, "subscription_status"),
        default=SubscriptionStatus.ACTIVE,
    )
    # Last day (inclusive, business timezone) the yonke has paid for.
    payment_due_date: Mapped[date] = mapped_column(Date)
    # SHA-256 of the device access token. The plain token is shown to the
    # broker once, at creation/regeneration, and typed into the yonke's device.
    access_token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    quotes: Mapped[list["Quote"]] = relationship(back_populates="yonke")

    def has_access(self, today: date) -> bool:
        return self.subscription_status == SubscriptionStatus.ACTIVE and self.payment_due_date >= today


class Request(Base):
    __tablename__ = "requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    vehicle_model: Mapped[str] = mapped_column(String(120))
    part_name: Mapped[str] = mapped_column(String(160))
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    status: Mapped[RequestStatus] = mapped_column(
        _str_enum(RequestStatus, "request_status"),
        default=RequestStatus.OPEN,
        index=True,
    )

    # The quote the broker picked ("Elegir esta"). Set together with status=CLOSED;
    # NULL when the request is open or was closed without a winner.
    # use_alter: requests <-> quotes reference each other.
    selected_quote_id: Mapped[int | None] = mapped_column(
        ForeignKey("quotes.id", use_alter=True, name="fk_requests_selected_quote", ondelete="SET NULL"),
        nullable=True,
    )

    quotes: Mapped[list["Quote"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="Quote.price",
        foreign_keys="Quote.request_id",
    )


class Quote(Base):
    __tablename__ = "quotes"
    # One quote per yonke per request; re-submitting updates it.
    __table_args__ = (UniqueConstraint("request_id", "yonke_id", name="uq_quote_request_yonke"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id", ondelete="CASCADE"), index=True)
    yonke_id: Mapped[int] = mapped_column(ForeignKey("yonkes.id", ondelete="CASCADE"), index=True)
    condition: Mapped[PartCondition] = mapped_column(_str_enum(PartCondition, "part_condition"))
    # Mexican pesos. asdecimal=False -> plain floats, JSON-friendly, no SQLite Decimal warning.
    price: Mapped[float] = mapped_column(Numeric(10, 2, asdecimal=False))
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    request: Mapped[Request] = relationship(back_populates="quotes", foreign_keys=[request_id])
    yonke: Mapped[Yonke] = relationship(back_populates="quotes")
