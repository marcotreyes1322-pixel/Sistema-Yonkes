# Sistema Yonkes

SaaS B2B privado para intermediar autopartes. El intermediario recibe pedidos
por redes sociales, los **transmite en tiempo real** a todos los yonkes
suscritos de la ciudad y recibe sus cotizaciones al instante. Cada yonke paga
una suscripción mensual; si no paga, pierde el acceso automáticamente.

Se distribuye como **PWA privada**: se instala en persona, desde el navegador,
en el teléfono o PC del yonke. Nada de tiendas de apps.

```
 Redes sociales ──► Intermediario ──(WebSocket)──► FastAPI ──(WebSocket)──► Yonkes activos
                    /intermedio/  ◄── cotización ──         ◄── cotización ── /recepcion/
```

## Estructura

```
backend/
  main.py        App FastAPI: endpoints WebSocket /ws/yonke y /ws/broker, sirve las PWAs
  realtime.py    ConnectionManager: conexiones por rol, broadcast, expulsiones
  events.py      Efectos en tiempo real (quién recibe qué) tras cada operación
  api.py         API REST del intermediario (yonkes, pagos, códigos, historial)
  services.py    Lógica de negocio (tokens, fechas de pago, cotizaciones)
  models.py      Modelos SQLAlchemy: Yonke, Request, Quote
  schemas.py     Validación (Pydantic) compartida por REST y WebSocket
  database.py    Motor SQLite/PostgreSQL y sesiones
  config.py      Variables de entorno
frontend/
  recepcion/     PWA del yonke: recibe solicitudes y cotiza
  intermedio/    PWA del intermediario: envía solicitudes, ve cotizaciones, administra yonkes
  shared/        Cliente WebSocket con reconexión, estilos e íconos
tests/           Pruebas de extremo a extremo del protocolo y las suscripciones
```

## Correr en local

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn backend.main:app --reload
```

- Panel del intermediario: <http://localhost:8000/intermedio/>
- App del yonke: <http://localhost:8000/recepcion/>
- Docs de la API: <http://localhost:8000/docs>

Si no defines `BROKER_TOKEN`, se genera uno la primera vez y se guarda en
`data/broker_token.txt` (se muestra en el log). Con ese token entras al panel.

Pruebas: `pytest`

## Configuración (variables de entorno)

| Variable | Default | Uso |
|---|---|---|
| `BROKER_TOKEN` | generado en `data/` | Contraseña del panel del intermediario. **Defínela en producción.** |
| `DATABASE_URL` | `sqlite:///data/yonkes.db` | Cambia a `postgresql+psycopg://…` para PostgreSQL. |
| `APP_TZ` | `America/Mexico_City` | Define qué es "hoy" para las fechas de pago. |
| `DATA_DIR` | `./data` | Carpeta de la base SQLite y el token generado. |
| `SUBSCRIPTION_SWEEP_SECONDS` | `60` | Cada cuánto se revisa si a un yonke conectado se le venció el pago. |
| `WS_AUTH_TIMEOUT` | `10` | Segundos para autenticarse al abrir el WebSocket. |

## Flujo de instalación con un yonke (en persona)

1. En el panel → **Yonkes** → registra nombre, teléfono y meses pagados.
2. Aparece un **código de acceso** (`XXXX-XXXX-XXXX`) y un **enlace de activación**.
   Solo se muestra una vez; si se pierde, usa **Nuevo código**.
3. Abre el enlace en el teléfono del yonke (o mándalo por WhatsApp desde el mismo
   diálogo). El dispositivo queda activado y el código desaparece de la URL.
4. Instalar en pantalla de inicio:
   - **Android (Chrome):** botón **Instalar** en la app, o menú ⋮ → *Instalar app*.
   - **iPhone (Safari):** Compartir → *Agregar a pantalla de inicio*. En iOS la app
     instalada no comparte datos con Safari: al abrirla por primera vez, **escribe
     el código** en la pantalla de activación.
   - **PC (Chrome/Edge):** ícono de instalar en la barra de direcciones.
5. Toca **Activar alertas** para permitir sonido y notificaciones.

> Las PWAs y los service workers **requieren HTTPS** (excepto en `localhost`).
> En producción sirve la app detrás de HTTPS (Render, Railway, Fly.io, o Nginx + Let's Encrypt).

## Despliegue en Render

| Recurso | Configuración |
|---|---|
| Web Service (Python) | Build: `pip install -r requirements.txt` · Start: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips="*"` · 1 instancia |
| PostgreSQL | Se conecta con `DATABASE_URL` (usa la *Internal Database URL*; el código acepta `postgres://` y `postgresql://`) |
| Variables | `DATABASE_URL`, `BROKER_TOKEN`, `APP_TZ` |

Las tablas se crean solas al arrancar, y `backend/database.py:migrate` agrega las columnas
nuevas a bases creadas por versiones anteriores (sin perder datos). **No uses SQLite en Render**: el disco del servicio
se borra en cada deploy o reinicio.

Plan **Free**: el servicio se duerme tras 15 min sin tráfico (tarda ~1 min en despertar) y
la base Free vence a los 30 días de creada. Antes de cobrar a los yonkes, cambia el servicio
a **Starter** y la base a **Basic** desde el dashboard (se conservan los datos).

Pruebas contra PostgreSQL local: `TEST_DATABASE_URL=postgresql://user@host/db pytest`

## Suscripciones

- Un yonke tiene acceso si `subscription_status = active` **y** `payment_due_date >= hoy`.
- **+1 mes**: si paga a tiempo, se suma al vencimiento actual; si paga tarde, cuenta desde hoy.
- **Suspender**: lo desconecta al instante de todos sus dispositivos.
- **Nuevo código**: invalida el código anterior y desconecta los dispositivos que lo usaban.
- El acceso se verifica al conectar, en cada cotización, antes de cada transmisión y
  cada minuto para los que ya estaban conectados. Un yonke vencido **nunca** recibe
  solicitudes, aunque tuviera la app abierta.
- La app del yonke avisa 5 días antes del vencimiento.

## Protocolo WebSocket

Endpoints: `/ws/yonke` y `/ws/broker`. Mensajes JSON con campo `type`. Cualquier
mensaje del cliente puede llevar `ref` (texto), que el servidor repite en su
respuesta o error.

1. El primer mensaje debe ser `{"type": "auth", "token": "…"}` (el token nunca va en la URL,
   así no queda en logs de proxies).
2. El servidor responde `hello` con el estado inicial, o cierra con:
   - `4001` código inválido o revocado → la app pide el código de nuevo.
   - `4003` suscripción inactiva → la app lo muestra y reintenta cada minuto.
3. `{"type": "ping"}` → `{"type": "pong"}` (el cliente lo envía cada 25 s).

**Yonke**

| Dirección | `type` | Contenido |
|---|---|---|
| ← | `hello` | `yonke`, `requests` abiertas (cada una con `my_quote`) + las que ganó en los últimos 3 días (`won: true`) |
| ← | `request.new` | `request` |
| ← | `request.closed` | `request_id`, `reason`: `selected` (se consiguió con otro yonke: ya no buscarla) o `closed` |
| ← | `request.won` | `request` con `won: true` y `my_quote`: el intermediario eligió **su** pieza, que la aparte |
| → | `quote.submit` | `request_id`, `condition` (`good`/`regular`/`bad`), `price`, `notes?` |
| ← | `quote.saved` | `quote` (se reenvía a todos los dispositivos del yonke) |
| ← | `access_denied` | `reason` (`token`/`subscription`), `message` — antes de cerrar |

Un yonke **nunca** ve las cotizaciones ni la identidad de otros yonkes. Volver a
cotizar la misma solicitud actualiza su cotización (una por yonke por solicitud).

**Intermediario**

| Dirección | `type` | Contenido |
|---|---|---|
| ← | `hello` | `requests` (con `quotes`), `yonkes`, `online` |
| → | `request.create` | `vehicle_model`, `part_name` |
| ← | `request.created` | `request`, `delivered_to` (yonkes que la recibieron) |
| → | `request.close` | `request_id` |
| → | `request.select` | `request_id`, `quote_id`: elige la cotización ganadora y cierra la solicitud |
| ← | `request.updated` | `request` |
| ← | `quote.new` / `quote.updated` | `quote` con datos del yonke |
| ← | `presence` | `online`: ids de yonkes conectados |
| ← | `yonke.updated` | `yonke` |

## API REST (intermediario)

Todas requieren `Authorization: Bearer <BROKER_TOKEN>`. Documentación interactiva en `/docs`.

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/yonkes` | Lista con estado de suscripción y si está en línea |
| POST | `/api/yonkes` | Registrar (`name`, `phone`, `months`) → devuelve el código una sola vez |
| PATCH | `/api/yonkes/{id}` | Editar nombre/teléfono/estado/fecha de pago |
| POST | `/api/yonkes/{id}/payments` | Registrar pago (`months`) |
| POST | `/api/yonkes/{id}/token` | Generar código nuevo (revoca el anterior) |
| GET | `/api/requests?status=open` | Historial con cotizaciones |
| POST | `/api/requests` | Crear y transmitir (igual que por WebSocket; útil para bots) |
| POST | `/api/requests/{id}/select` | Elegir cotización ganadora (`quote_id`): avisa al ganador y libera a los demás |
| POST | `/api/requests/{id}/close` | Cerrar solicitud sin ganador |

## Decisiones de diseño

- **Códigos de acceso** de 12 caracteres sin letras ambiguas (sin `I`, `O`, `0`, `1`),
  fáciles de dictar. En la base solo se guarda su hash SHA-256.
- **Un solo proceso**: el `ConnectionManager` vive en memoria, así que corre con
  **un worker** (`uvicorn backend.main:app --host 0.0.0.0 --port $PORT`). Un proceso
  asíncrono aguanta cientos de conexiones simultáneas, de sobra para una ciudad.
  Para escalar a varios procesos, el siguiente paso es Redis pub/sub.
- **Portabilidad a PostgreSQL**: enums como texto + `CHECK`, fechas en UTC con zona
  horaria. Basta cambiar `DATABASE_URL` e instalar `psycopg[binary]`. Para cambios de
  esquema posteriores conviene agregar **Alembic**.
- **Robustez móvil**: reconexión con backoff, detección de conexiones "zombies" por
  heartbeat, reconexión inmediata al volver a la app o recuperar señal, y service
  worker que abre la app aunque no haya internet.

## Siguientes pasos sugeridos

1. **Web Push (VAPID)**: notificaciones aunque la app esté cerrada (hoy suenan con la app abierta
   o en segundo plano reciente). Es lo más valioso para yonkes que no miran el teléfono.
2. **Fotos de la pieza** en la cotización (el cliente final confía más con foto).
3. **Filtros por marca/especialidad** del yonke para no saturar con piezas que no manejan.
4. **Historial de pagos** (tabla `payments`) para llevar tu contabilidad y recordatorios
   automáticos por WhatsApp antes del vencimiento.
5. **Métricas por yonke**: tiempo de respuesta y tasa de cotización, para premiar a los mejores.
6. Limitar intentos de autenticación por IP y desplegar con backups automáticos de la base.
