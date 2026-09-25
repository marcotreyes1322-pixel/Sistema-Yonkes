"""WebSocket connection manager.

Keeps track of every connected device, grouped by role:
  * brokers: the intermediary's screens (can be several: phone + PC)
  * yonkes:  yonke_id -> that yonke's devices (a yonke may also have several)

Every socket gets its own send lock and a send timeout, so one slow or dead
phone on a bad connection can never stall a broadcast to everyone else.
"""

import asyncio
import logging
from dataclasses import dataclass, field

from fastapi import WebSocket
from starlette.websockets import WebSocketState

log = logging.getLogger("yonkes.ws")

SEND_TIMEOUT = 5.0

# Application close codes (4000-4999 are reserved for apps by RFC 6455).
CLOSE_UNAUTHORIZED = 4001  # bad/revoked token -> client must log in again
CLOSE_NO_SUBSCRIPTION = 4003  # valid token, subscription inactive -> retry later


@dataclass(eq=False)
class Client:
    ws: WebSocket
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, message: dict) -> bool:
        if self.ws.application_state != WebSocketState.CONNECTED:
            return False
        try:
            async with self.lock:
                await asyncio.wait_for(self.ws.send_json(message), SEND_TIMEOUT)
            return True
        except Exception:  # disconnected, timed out, broken pipe...
            return False

    async def close(self, code: int, reason: str = "") -> None:
        try:
            await self.ws.close(code=code, reason=reason)
        except Exception:
            pass


class ConnectionManager:
    def __init__(self) -> None:
        self.brokers: set[Client] = set()
        self.yonkes: dict[int, set[Client]] = {}

    # --- registry ------------------------------------------------------------

    def add_broker(self, client: Client) -> None:
        self.brokers.add(client)

    def remove_broker(self, client: Client) -> None:
        self.brokers.discard(client)

    def add_yonke(self, yonke_id: int, client: Client) -> bool:
        """Register a device. Returns True if the yonke just came online."""
        devices = self.yonkes.setdefault(yonke_id, set())
        devices.add(client)
        return len(devices) == 1

    def remove_yonke(self, yonke_id: int, client: Client) -> bool:
        """Unregister a device. Returns True if the yonke just went offline."""
        devices = self.yonkes.get(yonke_id)
        if not devices or client not in devices:
            return False
        devices.discard(client)
        if not devices:
            del self.yonkes[yonke_id]
            return True
        return False

    def online_yonke_ids(self) -> list[int]:
        return sorted(self.yonkes)

    def is_online(self, yonke_id: int) -> bool:
        return yonke_id in self.yonkes

    # --- sending -------------------------------------------------------------

    async def _send_many(self, clients: list[Client], message: dict) -> list[bool]:
        if not clients:
            return []
        return list(await asyncio.gather(*(c.send(message) for c in clients)))

    async def send_to_brokers(self, message: dict) -> None:
        await self._send_many(list(self.brokers), message)

    async def send_to_yonke(self, yonke_id: int, message: dict) -> bool:
        results = await self._send_many(list(self.yonkes.get(yonke_id, ())), message)
        return any(results)

    async def broadcast_to_yonkes(self, message: dict, yonke_ids: list[int]) -> list[int]:
        """Send to every device of the given yonkes; returns ids reached on >=1 device."""
        targets = [(yid, c) for yid in yonke_ids for c in self.yonkes.get(yid, ())]
        results = await self._send_many([c for _, c in targets], message)
        return sorted({yid for (yid, _), ok in zip(targets, results, strict=True) if ok})

    async def broadcast_presence(self) -> None:
        await self.send_to_brokers({"type": "presence", "online": self.online_yonke_ids()})

    async def disconnect_yonke(self, yonke_id: int, code: int, message: dict | None = None) -> bool:
        """Kick every device of a yonke (suspended, expired, token revoked).

        Devices are unregistered right away so no broadcast can reach them
        while their sockets finish closing. Returns True if it was online.
        """
        clients = self.yonkes.pop(yonke_id, set())
        for client in clients:
            if message:
                await client.send(message)
            await client.close(code)
        return bool(clients)


manager = ConnectionManager()
