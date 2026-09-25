"""Pydantic payloads, shared by the REST API and the WebSocket protocol."""

from datetime import date
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .models import PartCondition, SubscriptionStatus

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, min_length=7, max_length=30)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="ignore")


class RequestCreate(_Strict):
    vehicle_model: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=120)]
    part_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=160)]


class QuoteSubmit(_Strict):
    request_id: int
    condition: PartCondition
    price: float = Field(gt=0, le=10_000_000)
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None


class QuoteSelect(_Strict):
    quote_id: int


class YonkeCreate(_Strict):
    name: Name
    phone: Phone
    months: int = Field(default=1, ge=1, le=24, description="Months paid up front")


class YonkeUpdate(_Strict):
    name: Name | None = None
    phone: Phone | None = None
    subscription_status: SubscriptionStatus | None = None
    payment_due_date: date | None = None


class PaymentIn(_Strict):
    months: int = Field(default=1, ge=1, le=24)
