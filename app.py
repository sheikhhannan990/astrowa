from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import os
import json
import logging
import sys
import threading
import time
import mimetypes
import re
import functools
from datetime import datetime, timedelta, timezone
import shutil
import subprocess
import tempfile
import requests
from supabase import create_client

load_dotenv()

# Logging: route everything to stderr so it shows up in PythonAnywhere's
# Error log (the same log where httpx prints its outgoing request lines).
# print() goes to stdout which on PA lands in the Server log — easy to
# miss when debugging.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
    force=True,
)
log = logging.getLogger("astrowa")

app = Flask(__name__)

# =========================
# ENV VARIABLES
# =========================

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
TEMPLATE_NAME = os.getenv("WHATSAPP_TEMPLATE_NAME")
FULFILLMENT_TEMPLATE_NAME = os.getenv("WHATSAPP_FULFILLMENT_TEMPLATE_NAME")
BANK_DEPOSIT_TEMPLATE_NAME = (os.getenv("WHATSAPP_BANK_DEPOSIT_TEMPLATE_NAME") or "").strip()
TEMPLATE_LANGUAGE = os.getenv("WHATSAPP_TEMPLATE_LANGUAGE", "en")
WHATSAPP_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN")

# Optional: Bank account details rendered into the inbox copy of bank-deposit
# messages so the merchant sees the same thing the customer saw. The customer
# always sees the bank details that are baked into the approved Meta template.
# Convert literal \n (which python-dotenv passes through verbatim) into real
# newlines so the inbox renders the details on multiple lines.
BANK_DETAILS_TEXT = (os.getenv("BANK_DETAILS_TEXT") or "").strip().replace("\\n", "\n")

# Optional: discount in Rs. deducted from the order total when the customer
# pays by Bank Deposit. Encoded into the template's amount variable so the
# customer sees both the original price and the discounted total.
try:
    BANK_DEPOSIT_DISCOUNT = float(os.getenv("BANK_DEPOSIT_DISCOUNT", "0") or "0")
except ValueError:
    BANK_DEPOSIT_DISCOUNT = 0.0

FRONTEND_URL = os.getenv("FRONTEND_URL", "").strip()

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def _normalize_origin(o):
    """Strip trailing slash + lowercase so 'https://x.com' and
    'https://x.com/' both match. This avoids the most common
    FRONTEND_URL typo silently breaking CORS."""
    return (o or "").rstrip("/").lower()


# CORS: lock down origins so prod (Netlify) and dev (Vite) both work, but
# nothing else can hit the API from a browser.
# FRONTEND_URL may be a single URL or a comma-separated list of URLs so the
# merchant can keep both an old preview deploy and a new prod deploy working
# without having to remember to update the backend after every Netlify rename.
_allowed_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
if FRONTEND_URL:
    for raw in FRONTEND_URL.split(","):
        cleaned = raw.strip()
        if cleaned:
            _allowed_origins.append(cleaned)
_allowed_origins_normalized = {_normalize_origin(o) for o in _allowed_origins}
log.info(f"CORS allowed_origins = {_allowed_origins}")
CORS(app, origins=_allowed_origins)


@app.before_request
def _log_request():
    # Skip noisy webhook traffic; we only need this for inbox UI calls.
    if request.path in ("/", "/shopify/order-created", "/shopify/order-fulfilled", "/whatsapp/webhook"):
        return
    log.info(
        f"REQ {request.method} {request.path} origin={request.headers.get('Origin', '-')} ua={(request.headers.get('User-Agent', '') or '')[:40]}"
    )


# Belt-and-suspenders: ensure CORS headers are on EVERY response, including
# ones from Flask's default error pages. flask-cors normally handles this,
# but error responses occasionally slip through.
@app.after_request
def _ensure_cors_headers(resp):
    origin = request.headers.get("Origin", "")
    if origin and _normalize_origin(origin) in _allowed_origins_normalized:
        # Echo the EXACT origin back (browsers reject responses where
        # ACAO doesn't byte-match the request's Origin).
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers.setdefault("Vary", "Origin")
        resp.headers.setdefault(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Requested-With, X-Staff-Id",
        )
        resp.headers.setdefault(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        )
    return resp


@app.route("/diag", methods=["GET"])
def diag():
    """Diagnostic endpoint. Open in the browser from the Netlify site
    via fetch('/diag') OR hit directly to verify the backend is up.
    Returns the Origin header it received + the CORS allow-list."""
    origin = request.headers.get("Origin", "")
    return jsonify({
        "ok": True,
        "request_origin": origin or None,
        "request_origin_normalized": _normalize_origin(origin) or None,
        "allowed_origins": _allowed_origins,
        "allowed_origins_normalized": sorted(_allowed_origins_normalized),
        "origin_matches": _normalize_origin(origin) in _allowed_origins_normalized if origin else None,
        "frontend_url_env": FRONTEND_URL or None,
    })


# Global safety net: any unhandled exception inside a request handler is
# converted to a JSON response. Flask's default 500 page is plain HTML
# without CORS headers, which makes the browser swallow the real error as
# a generic "CORS error" — losing all diagnostic value.
@app.errorhandler(Exception)
def _json_error_handler(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        resp = jsonify({
            "success": False,
            "error": e.description or e.name,
        })
        resp.status_code = e.code
        return resp
    log.exception(f"UNHANDLED EXCEPTION on {request.method} {request.path}: {type(e).__name__}: {e}")
    resp = jsonify({
        "success": False,
        "error": f"Server error: {type(e).__name__}: {str(e)[:300]}",
    })
    resp.status_code = 500
    return resp


# =========================
# IDEMPOTENCY CACHE
# =========================
#
# Shopify retries any webhook that doesn't 200 quickly. We absorb retries +
# accidental double-fires with two in-memory sets, reserved BEFORE any network
# IO, plus the DB check that survives process restarts.
_DEDUP_LOCK = threading.Lock()
_PROCESSED_WEBHOOK_IDS = set()
_PROCESSED_ORDER_KEYS = set()
_PROCESSED_FULFILLMENT_KEYS = set()
_MAX_DEDUP_ENTRIES = 1000


def _remember(cache, key):
    if not key:
        return
    if len(cache) >= _MAX_DEDUP_ENTRIES:
        cache.clear()
    cache.add(key)


def _is_unique_violation(e):
    return getattr(e, "code", None) == "23505" or "duplicate key" in str(e).lower()


def claim_event(key):
    """Atomically mark `key` as handled. Returns True for the first caller
    only, across every PythonAnywhere worker process (the in-memory sets
    above are per-process, so they can't stop two workers both handling
    the same webhook retry).

    Backed by the processed_events table's primary key. If the table
    doesn't exist yet, fail open (return True) so webhooks keep working
    exactly as before."""
    if not key:
        return True
    try:
        supabase.table("processed_events").insert({"key": key}).execute()
        return True
    except Exception as e:
        if _is_unique_violation(e):
            return False
        log.warning(f"claim_event({key}) failed, processing anyway (is processed_events created?): {e}")
        return True


def release_event(key):
    """Undo claim_event so a retry can try again. Only used when we failed
    BEFORE sending anything, so a retry can never double-send."""
    if not key:
        return
    try:
        supabase.table("processed_events").delete().eq("key", key).execute()
    except Exception as e:
        log.warning(f"release_event({key}) failed: {e}")


# =========================
# TEAM MEMBERS & ACTIVITY LOG
# =========================
#
# No login: each device picks "who's using this inbox" once and sends that
# staff id in the X-Staff-Id header. It's used to record who did what (for
# the activity log), not to restrict access.

_STAFF_CACHE = {}         # staff id -> (expires_at, row)
_STAFF_CACHE_SECONDS = 60
_STAFF_LOCK = threading.Lock()
_UNKNOWN_STAFF = {"user_id": None, "name": "Unknown", "role": "agent", "active": True}


def _staff_for_id(staff_id):
    if not staff_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", staff_id):
        return None
    now = time.time()
    with _STAFF_LOCK:
        hit = _STAFF_CACHE.get(staff_id)
        if hit and hit[0] > now:
            return hit[1]
    try:
        rows = supabase.table("staff").select("*").eq("user_id", staff_id).limit(1).execute().data or []
    except Exception as e:
        log.warning(f"staff lookup failed: {e}")
        return None
    staff = rows[0] if rows else None
    with _STAFF_LOCK:
        if len(_STAFF_CACHE) > 200:
            _STAFF_CACHE.clear()
        _STAFF_CACHE[staff_id] = (now + _STAFF_CACHE_SECONDS, staff)
    return staff


def require_staff():
    """Route decorator: passes the team member using this device as `staff`
    (or "Unknown" if the device hasn't picked a name). Never blocks — the
    inbox stays open to anyone with the link, as before."""
    def wrap(fn):
        @functools.wraps(fn)
        def inner(*args, **kwargs):
            if request.method == "OPTIONS":
                return "", 204
            staff = _staff_for_id(request.headers.get("X-Staff-Id", "").strip()) or _UNKNOWN_STAFF
            return fn(*args, staff=staff, **kwargs)
        return inner
    return wrap


def log_activity(staff, kind, summary, conversation_id=None, order_id=None, meta=None):
    """Append to the activity log. Never raises — logging must not break
    the action it describes."""
    try:
        supabase.table("activity").insert({
            "actor_id": (staff or {}).get("user_id"),
            "actor_name": (staff or {}).get("name") or "System",
            "kind": kind,
            "summary": summary,
            "conversation_id": conversation_id,
            "order_id": order_id,
            "meta": meta,
        }).execute()
    except Exception as e:
        log.warning(f"log_activity({kind}) failed: {e}")


# =========================
# HELPERS
# =========================

def format_phone(phone):
    """Normalize a phone number to E.164-ish form without the leading +.

    Tuned for Pakistan (country code 92). Handles all common formats so
    Shopify + WhatsApp + manual entries land on the same canonical key:
        03001234567        -> 923001234567
        +92 300 1234567    -> 923001234567
        923001234567       -> 923001234567
        3001234567         -> 923001234567   (10-digit local, no leading 0)
    """
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if not digits:
        return ""
    # Pakistani mobile (3XXXXXXXXX) behind any mix of 0 / 92 / 0092 — this
    # also repairs inputs like "+92 0300…" that used to become "920300…"
    # and were then wrongly flagged as "Not on WhatsApp".
    pk_mobile = re.fullmatch(r"(?:0|92|0092)*(3\d{9})", digits)
    if pk_mobile:
        return "92" + pk_mobile.group(1)
    if digits.startswith("0"):
        digits = "92" + digits[1:]
    elif not digits.startswith("92") and len(digits) == 10:
        digits = "92" + digits
    return digits


# Stable tags written to conversations.last_template so the frontend
# can render a status pill without needing to know template names.
TEMPLATE_TAG_CONFIRMATION = "confirmation"   # COD template sent, awaiting customer
TEMPLATE_TAG_BANK_PENDING = "bank_pending"   # Bank deposit template sent, awaiting payment proof
TEMPLATE_TAG_CONFIRMED = "confirmed"         # Customer tapped Confirm Order
TEMPLATE_TAG_PAID = "paid"                   # Merchant verified bank-deposit payment
TEMPLATE_TAG_FULFILLED = "fulfilled"         # Order shipped

# Tags the merchant is allowed to set manually from the UI. Webhook-driven
# tags (confirmation / fulfilled / confirmed) are intentionally excluded so
# the merchant can't accidentally rewind a Shopify-driven status.
_MANUALLY_SETTABLE_TAGS = {
    TEMPLATE_TAG_CONFIRMATION,
    TEMPLATE_TAG_BANK_PENDING,
    TEMPLATE_TAG_CONFIRMED,
    TEMPLATE_TAG_PAID,
    TEMPLATE_TAG_FULFILLED,
    None,  # allow clearing the tag
}

# Supabase Storage bucket where incoming WhatsApp media (images, audio,
# video, documents, stickers) gets uploaded. Bucket must exist and be
# Public so the frontend can render the media via the returned URL.
WHATSAPP_MEDIA_BUCKET = "whatsapp-media"


def _ext_for_mime(mime_type):
    """Best-effort filename extension for a given mime type."""
    if not mime_type:
        return ".bin"
    base = mime_type.split(";")[0].strip()
    return mimetypes.guess_extension(base) or ".bin"


def fetch_whatsapp_media(media_id):
    """Resolve a WhatsApp media id to (bytes, mime_type).

    The Cloud API exposes media in two steps: first an authenticated
    metadata call returns a short-lived (~5 min) download URL, then a
    second authenticated request actually downloads the bytes.
    Returns (None, None) on any failure.
    """
    if not media_id:
        return None, None
    try:
        meta_resp = requests.get(
            f"https://graph.facebook.com/v20.0/{media_id}",
            headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"},
            timeout=15,
        )
        if meta_resp.status_code != 200:
            print(f"Media metadata fetch failed ({media_id}): {meta_resp.status_code} {meta_resp.text[:200]}")
            return None, None
        meta = meta_resp.json() or {}
        url = meta.get("url")
        mime = meta.get("mime_type")
        if not url:
            return None, None

        media_resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"},
            timeout=30,
        )
        if media_resp.status_code != 200:
            print(f"Media bytes fetch failed ({media_id}): {media_resp.status_code}")
            return None, None
        return media_resp.content, mime
    except Exception as e:
        print(f"Media fetch error ({media_id}): {e}")
        return None, None


def upload_media_to_storage(message_type, media_id, content, mime_type):
    """Upload media bytes to Supabase Storage and return a public URL.

    Tolerates "already exists" errors so retries (Shopify or WhatsApp
    re-delivering the same webhook) don't blow up — we just reuse the
    existing object.
    """
    if not content or not media_id:
        return None
    ext = _ext_for_mime(mime_type)
    path = f"{message_type}/{media_id}{ext}"
    try:
        supabase.storage.from_(WHATSAPP_MEDIA_BUCKET).upload(
            path=path,
            file=content,
            file_options={
                "content-type": mime_type or "application/octet-stream",
                "upsert": "true",
            },
        )
    except Exception as e:
        msg = str(e).lower()
        if "already exists" not in msg and "duplicate" not in msg:
            print(f"Storage upload error for {path}: {e}")
    try:
        return supabase.storage.from_(WHATSAPP_MEDIA_BUCKET).get_public_url(path)
    except Exception as e:
        print(f"Storage URL error for {path}: {e}")
        return None


# WhatsApp Cloud API error codes that indicate the recipient cannot
# receive messages (most commonly because the number isn't on WhatsApp).
# We flag the conversation so the UI can show a "Not on WhatsApp" tag.
_NOT_ON_WHATSAPP_ERROR_CODES = {131026, 131049, 131050, 131000, 470}


def get_customer_phone(order):
    return (
        order.get("phone")
        or (order.get("shipping_address") or {}).get("phone")
        or (order.get("billing_address") or {}).get("phone")
        or (order.get("customer") or {}).get("phone")
        or ((order.get("customer") or {}).get("default_address") or {}).get("phone")
    )


def _customer_name_from(order):
    customer = order.get("customer") or {}
    shipping = order.get("shipping_address") or {}
    return (
        shipping.get("name")
        or f"{customer.get('first_name', '')} {customer.get('last_name', '')}".strip()
        or "Customer"
    )


def _extract_shipping_address(order):
    """Pull a compact, frontend-friendly subset of Shopify's shipping_address
    so we can show the merchant the customer's address inside the inbox
    (helps them spot incomplete addresses without leaving WhatsApp).

    Falls back to billing_address or customer.default_address when the
    shipping_address isn't present (digital orders, draft orders, etc.).
    Returns None when no usable address exists."""
    addr = (
        order.get("shipping_address")
        or order.get("billing_address")
        or ((order.get("customer") or {}).get("default_address"))
        or {}
    )
    if not addr:
        return None

    def _s(key):
        v = addr.get(key)
        return v.strip() if isinstance(v, str) else (v or None)

    payload = {
        "name": _s("name") or " ".join(filter(None, [_s("first_name"), _s("last_name")])).strip() or None,
        "phone": _s("phone"),
        "address1": _s("address1"),
        "address2": _s("address2"),
        "city": _s("city"),
        "province": _s("province"),
        "zip": _s("zip"),
        "country": _s("country"),
        "company": _s("company"),
    }
    # Drop empty values to keep the JSON compact.
    payload = {k: v for k, v in payload.items() if v}
    return payload or None


def extract_order_data(order):
    products = []
    for item in order.get("line_items", []) or []:
        title = (item.get("title") or "").strip()
        variant = (item.get("variant_title") or "").strip()
        qty = item.get("quantity") or 1

        # Shopify fills variant_title with "Default Title" for products that
        # have no variants — we only want to surface meaningful variant names.
        if variant and variant.lower() != "default title":
            products.append(f"{title} ({variant}) x {qty}")
        else:
            products.append(f"{title} x {qty}")

    return {
        "customer_name": _customer_name_from(order),
        "customer_phone": get_customer_phone(order),
        "order_number": order.get("name") or str(order.get("order_number")),
        "products_text": ", ".join(products),
        "total_price": order.get("total_price"),
        "shipping_address": _extract_shipping_address(order),
    }


def extract_fulfillment_data(order):
    """Pull data for the order_dispatched template from a Shopify fulfillment payload."""
    fulfillments = order.get("fulfillments") or []
    latest = fulfillments[-1] if fulfillments else {}

    tracking_company = (latest.get("tracking_company") or "").strip() or "Our courier partner"
    tracking_number = (latest.get("tracking_number") or "").strip() or "Available within 24h"

    # Prefer the fulfillment's own line items (only what was shipped in this
    # parcel for split shipments); fall back to the whole order's line items.
    fulfillment_items = latest.get("line_items") or order.get("line_items") or []
    products = []
    for item in fulfillment_items:
        title = (item.get("title") or "").strip()
        variant = (item.get("variant_title") or "").strip()
        qty = item.get("quantity") or 1
        if variant and variant.lower() != "default title":
            products.append(f"{title} ({variant}) x {qty}")
        else:
            products.append(f"{title} x {qty}")
    products_text = ", ".join(products) or "—"

    return {
        "customer_name": _customer_name_from(order),
        "customer_phone": get_customer_phone(order),
        "order_number": order.get("name") or str(order.get("order_number")),
        "tracking_company": tracking_company,
        "tracking_number": tracking_number,
        "products_text": products_text,
    }


def _bare_order_number(order_number):
    """Strip a leading '#' from a Shopify-style order name for use as a
    Meta template variable. Shopify's `order.name` is '#12431'; templates
    that hard-code '#' before the variable (e.g. 'order #{{2}}') would
    otherwise render '##12431'."""
    return str(order_number or "").lstrip("#").strip()


def _real_tracking_number(value):
    """Return the value only if it looks like a real tracking number.

    extract_fulfillment_data() falls back to 'Available within 24h' when
    Shopify hasn't filled in a tracking number yet; we don't want that
    sentinel persisted to conversations.tracking_number (it would render
    a broken Track button in the inbox)."""
    if not value:
        return None
    s = str(value).strip()
    if not s or s.lower().startswith("available"):
        return None
    return s


def _real_tracking_company(value):
    if not value:
        return None
    s = str(value).strip()
    if not s or s.lower().startswith("our courier"):
        return None
    return s


# =========================
# WHATSAPP TEMPLATE SEND
# =========================

def _send_template(template_name, phone, variables, button_params=None):
    """Generic template sender. variables is an ordered list of body strings.
    button_params, if given, is an ordered list of strings for dynamic URL
    button parameters — index-matched to the button's position in the
    template (index 0 = first button)."""
    if not template_name:
        print(f"Cannot send template — template name not configured.")
        return None

    components = [
        {
            "type": "body",
            "parameters": [{"type": "text", "text": str(v)} for v in variables],
        }
    ]

    if button_params:
        for i, param in enumerate(button_params):
            components.append({
                "type": "button",
                "sub_type": "url",
                "index": str(i),
                "parameters": [{"type": "text", "text": str(param)}],
            })

    url = f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": format_phone(phone),
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": TEMPLATE_LANGUAGE},
            "components": components,
        },
    }
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }

    response = requests.post(url, headers=headers, json=payload)
    print(f"===== WHATSAPP TEMPLATE [{template_name}] =====")
    print(response.status_code)
    print(response.text)

    if response.status_code in [200, 201]:
        return response.json().get("messages", [{}])[0].get("id")
    return None


def _parse_amount(value):
    """Coerce Shopify's stringy total to a float; None / bad input -> 0."""
    try:
        return float(value or 0)
    except (ValueError, TypeError):
        return 0.0


def _discounted_total(original_price):
    """Original total minus BANK_DEPOSIT_DISCOUNT, floored at 0."""
    original_f = _parse_amount(original_price)
    if BANK_DEPOSIT_DISCOUNT <= 0:
        return original_f
    return max(0.0, original_f - BANK_DEPOSIT_DISCOUNT)


def send_whatsapp_confirmation(data):
    """COD template — 4 variables: name, order#, items, total."""
    return _send_template(
        TEMPLATE_NAME,
        data["customer_phone"],
        [
            data["customer_name"],
            _bare_order_number(data["order_number"]),
            data["products_text"],
            f"{_parse_amount(data['total_price']):.2f}",
        ],
    )


def send_whatsapp_bank_deposit(data):
    """Bank deposit template — 5 variables:
    name, order#, items, subtotal, discounted total."""
    original_f = _parse_amount(data["total_price"])
    final = _discounted_total(original_f)
    return _send_template(
        BANK_DEPOSIT_TEMPLATE_NAME,
        data["customer_phone"],
        [
            data["customer_name"],
            _bare_order_number(data["order_number"]),
            data["products_text"],
            f"{original_f:.2f}",
            f"{final:.2f}",
        ],
    )


def send_whatsapp_fulfillment(data):
    """Dispatch template — 5 body variables:
    name, order#, courier, tracking, items.
    Plus 1 dynamic button param: tracking number, appended to the Postex
    tracking URL registered on the template's "Track Your Order" button
    (https://postex.pk/tracking?cn={{1}})."""
    tracking_number = data["tracking_number"]
    return _send_template(
        FULFILLMENT_TEMPLATE_NAME,
        data["customer_phone"],
        [
            data["customer_name"],
            _bare_order_number(data["order_number"]),
            data["tracking_company"],
            tracking_number,
            data["products_text"],
        ],
        button_params=[tracking_number],
    )


def send_whatsapp_text(to, body):
    """Send a free-form WhatsApp text. Only allowed inside the 24-hour
    customer-service window (i.e. after the customer messaged us).
    Returns the WhatsApp message id, or None if the send failed."""
    if not to or not body:
        return None
    url = f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": format_phone(to),
        "type": "text",
        "text": {"body": body},
    }
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=15)
    except Exception as e:
        print(f"send_whatsapp_text error: {e}")
        return None
    print(f"===== WHATSAPP TEXT REPLY -> {to} =====")
    print(response.status_code, response.text[:300])
    if response.status_code in [200, 201]:
        return response.json().get("messages", [{}])[0].get("id")
    return None


_BANK_GATEWAY_HINTS = ("bank", "deposit", "transfer")


def is_bank_deposit_order(order):
    """True if the customer chose a bank-deposit / bank-transfer gateway."""
    candidates = []
    gateways = order.get("payment_gateway_names")
    if isinstance(gateways, list):
        candidates.extend(gateways)
    elif isinstance(gateways, str):
        candidates.append(gateways)
    if order.get("gateway"):
        candidates.append(order.get("gateway"))
    for g in candidates:
        if not g:
            continue
        gl = g.lower()
        if any(h in gl for h in _BANK_GATEWAY_HINTS):
            return True
    return False


# =========================
# SUPABASE HELPERS
# =========================

def get_or_create_customer(name, phone):
    phone = format_phone(phone)

    existing = supabase.table("customers").select("*").eq("phone", phone).limit(1).execute()

    if existing.data:
        customer = existing.data[0]
        if name and customer.get("name") != name:
            supabase.table("customers").update({"name": name}).eq("id", customer["id"]).execute()
            customer["name"] = name
        return customer

    created = supabase.table("customers").insert({
        "name": name,
        "phone": phone,
    }).execute()

    return created.data[0]


def get_or_create_conversation(customer, phone, customer_name=None, order_id=None):
    phone = format_phone(phone)

    existing = (
        supabase.table("conversations")
        .select("*")
        .eq("phone", phone)
        .eq("status", "open")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    if existing.data:
        conversation = existing.data[0]
        update_data = {"updated_at": "now()"}
        if customer_name:
            update_data["customer_name"] = customer_name
        if order_id:
            update_data["order_id"] = order_id
        supabase.table("conversations").update(update_data).eq("id", conversation["id"]).execute()
        return conversation

    created = supabase.table("conversations").insert({
        "customer_id": customer["id"],
        "phone": phone,
        "customer_name": customer_name or customer.get("name") or "Customer",
        "order_id": order_id,
        "status": "open",
        "unread_count": 0,
    }).execute()

    return created.data[0]


def record_customer_order(phone, order_number, shopify_order_id=None, shopify_orders_count=None):
    """Remember that `phone` placed `order_number` and return how many orders
    this customer has placed in total (including this one).

    Orders are stored in the customer_orders table (unique on phone +
    order_number) so Shopify webhook retries don't double-count. Shopify's
    own customer.orders_count, when the payload carries it, is used as a
    floor so customers who ordered before this inbox existed still show
    their real history.

    Never raises — the order-count badge is a nice-to-have and must not
    block the confirmation template. Returns None if nothing could be
    determined (e.g. the customer_orders table hasn't been created yet)."""
    phone = format_phone(phone)
    if not phone or not order_number:
        return None

    db_count = None
    try:
        supabase.table("customer_orders").upsert(
            {
                "phone": phone,
                "order_number": str(order_number),
                "shopify_order_id": str(shopify_order_id) if shopify_order_id else None,
            },
            on_conflict="phone,order_number",
            ignore_duplicates=True,
        ).execute()
        counted = (
            supabase.table("customer_orders")
            .select("id", count="exact")
            .eq("phone", phone)
            .execute()
        )
        db_count = counted.count
    except Exception as e:
        log.warning(f"record_customer_order failed (is the customer_orders table created?): {e}")

    try:
        shopify_count = int(shopify_orders_count) if shopify_orders_count is not None else None
    except (TypeError, ValueError):
        shopify_count = None

    candidates = [c for c in (db_count, shopify_count) if c]
    return max(candidates) if candidates else None


def set_conversation_order_count(conversation_id, order_count):
    """Store the customer's order count on the conversation. Kept separate
    from the main conversation update so a missing `order_count` column
    can't break message logging."""
    if not conversation_id or not order_count:
        return
    try:
        supabase.table("conversations").update(
            {"order_count": order_count}
        ).eq("id", conversation_id).execute()
    except Exception as e:
        log.warning(f"Could not save order_count on conversation {conversation_id}: {e}")


def log_outgoing_order_message(data, whatsapp_message_id):
    phone = format_phone(data["customer_phone"])

    customer = get_or_create_customer(name=data["customer_name"], phone=phone)
    conversation = get_or_create_conversation(
        customer=customer,
        phone=phone,
        customer_name=data["customer_name"],
        order_id=data["order_number"],
    )

    message_body = (
        f"Hi {data['customer_name']}, 👋\n\n"
        f"We're pleased to inform you that your order {data['order_number']} has been received successfully and is awaiting confirmation.\n\n"
        f"Items in your order: {data['products_text']}\n\n"
        f"Order Total: Rs. {_parse_amount(data['total_price']):.2f}\n\n"
        f"Estimated Delivery: 2–4 Working Days\n\n"
        f"Please confirm your order below so we can proceed with dispatch.\n\n"
        f"Thank you for choosing AstroLamps. We truly appreciate your trust! ✨"
    )

    preview_body = (
        f"Order {data['order_number']} | "
        f"{data['products_text']} | "
        f"Rs. {_parse_amount(data['total_price']):.2f}"
    )

    supabase.table("messages").insert({
        "conversation_id": conversation["id"],
        "whatsapp_message_id": whatsapp_message_id,
        "direction": "outgoing",
        "type": "template",
        "body": message_body,
        "template_name": TEMPLATE_NAME,
        "status": "sent",
        "raw_payload": data,
    }).execute()

    conv_update = {
        "last_message": preview_body,
        "last_message_at": "now()",
        "last_template": TEMPLATE_TAG_CONFIRMATION,
        "is_cancelled": False,
        "updated_at": "now()",
    }
    if data.get("shipping_address"):
        conv_update["shipping_address"] = data["shipping_address"]
    supabase.table("conversations").update(conv_update).eq("id", conversation["id"]).execute()

    print(f"Outgoing confirmation logged in Supabase.")
    return conversation["id"]


def log_outgoing_bank_deposit_message(data, whatsapp_message_id):
    phone = format_phone(data["customer_phone"])

    customer = get_or_create_customer(name=data["customer_name"], phone=phone)
    conversation = get_or_create_conversation(
        customer=customer,
        phone=phone,
        customer_name=data["customer_name"],
        order_id=data["order_number"],
    )

    bank_section = BANK_DETAILS_TEXT or "(Bank details are shown to the customer inside the WhatsApp template.)"

    original_f = _parse_amount(data["total_price"])
    final = _discounted_total(original_f)
    discount_label = f"Rs{BANK_DEPOSIT_DISCOUNT:.0f}" if BANK_DEPOSIT_DISCOUNT > 0 else "no"

    message_body = (
        f"Hi {data['customer_name']}, 👋\n\n"
        f"We've received your order {data['order_number']} successfully.\n\n"
        f"Items in your order: {data['products_text']}\n\n"
        f"💳 Payment Details\n"
        f"Order Subtotal: Rs. {original_f:.2f}\n"
        f"Updated Amount After Discount ({discount_label} off): Rs. {final:.2f}\n\n"
        f"🏦 {bank_section}\n\n"
        f"📸 After making the payment, please send a screenshot of the transaction receipt here.\n\n"
        f"Your order will be confirmed and prepared for dispatch once payment has been verified.\n\n"
        f"Thank you for choosing AstroLamps."
    )

    preview_body = (
        f"Bank Deposit | Order {data['order_number']} | Rs. {final:.2f}"
        + (f" (Rs. {BANK_DEPOSIT_DISCOUNT:.0f} off)" if BANK_DEPOSIT_DISCOUNT > 0 else "")
    )

    supabase.table("messages").insert({
        "conversation_id": conversation["id"],
        "whatsapp_message_id": whatsapp_message_id,
        "direction": "outgoing",
        "type": "template",
        "body": message_body,
        "template_name": BANK_DEPOSIT_TEMPLATE_NAME,
        "status": "sent",
        "raw_payload": data,
    }).execute()

    conv_update = {
        "last_message": preview_body,
        "last_message_at": "now()",
        "last_template": TEMPLATE_TAG_BANK_PENDING,
        "is_cancelled": False,
        "updated_at": "now()",
    }
    if data.get("shipping_address"):
        conv_update["shipping_address"] = data["shipping_address"]
    supabase.table("conversations").update(conv_update).eq("id", conversation["id"]).execute()

    print("Outgoing bank-deposit message logged in Supabase.")
    return conversation["id"]


# Auto-reply sent right after the customer taps the "Confirm Order"
# button on the COD confirmation template. Free-form text is valid here
# because the customer's tap opened a fresh 24-hour service window.
CONFIRM_AUTO_REPLY_BODY = (
    "Thank you for confirming your order ✨\n\n"
    "We're getting it ready now and you'll receive a dispatch update from us shortly 📦\n\n"
    "Team AstroLamps"
)


def send_confirm_auto_reply(conversation, phone):
    """Send the post-Confirm thank-you text and log it as outgoing."""
    message_id = send_whatsapp_text(phone, CONFIRM_AUTO_REPLY_BODY)
    if not message_id:
        print("Confirm auto-reply send failed; nothing logged.")
        return
    try:
        supabase.table("messages").insert({
            "conversation_id": conversation["id"],
            "whatsapp_message_id": message_id,
            "direction": "outgoing",
            "type": "text",
            "body": CONFIRM_AUTO_REPLY_BODY,
            "status": "sent",
            "raw_payload": {"auto_reply": "confirm"},
        }).execute()
        supabase.table("conversations").update({
            "last_message": "Thank you for confirming your order ✨",
            "last_message_at": "now()",
            "updated_at": "now()",
        }).eq("id", conversation["id"]).execute()
        print("Confirm auto-reply sent and logged.")
    except Exception as e:
        print(f"Confirm auto-reply log error: {e}")


def log_outgoing_fulfillment_message(data, whatsapp_message_id):
    phone = format_phone(data["customer_phone"])

    customer = get_or_create_customer(name=data["customer_name"], phone=phone)
    conversation = get_or_create_conversation(
        customer=customer,
        phone=phone,
        customer_name=data["customer_name"],
        order_id=data["order_number"],
    )

    message_body = (
        f"Hi {data['customer_name']} 👋\n\n"
        f"We're pleased to inform you that your order {data['order_number']} has been successfully dispatched.\n\n"
        f"Courier: {data['tracking_company']}\n"
        f"Tracking #: {data['tracking_number']}\n"
        f"Items in your shipment: {data['products_text']}\n\n"
        f"🚚 Expected delivery: 2-3 working days\n\n"
        f"Thank you for shopping with us."
    )

    preview_body = (
        f"📦 Dispatched via {data['tracking_company']} | "
        f"Tracking: {data['tracking_number']}"
    )

    supabase.table("messages").insert({
        "conversation_id": conversation["id"],
        "whatsapp_message_id": whatsapp_message_id,
        "direction": "outgoing",
        "type": "template",
        "body": message_body,
        "template_name": FULFILLMENT_TEMPLATE_NAME,
        "status": "sent",
        "raw_payload": data,
    }).execute()

    conv_update = {
        "last_message": preview_body,
        "last_message_at": "now()",
        "last_template": TEMPLATE_TAG_FULFILLED,
        "is_cancelled": False,
        "updated_at": "now()",
    }
    real_tracking = _real_tracking_number(data.get("tracking_number"))
    real_company = _real_tracking_company(data.get("tracking_company"))
    if real_tracking:
        conv_update["tracking_number"] = real_tracking
    if real_company:
        conv_update["tracking_company"] = real_company

    supabase.table("conversations").update(conv_update).eq("id", conversation["id"]).execute()

    print(f"Outgoing fulfillment logged in Supabase.")
    return conversation["id"]


_MEDIA_TYPE_ICONS = {
    "image": "📷 Image",
    "audio": "🎤 Voice note",
    "voice": "🎤 Voice note",
    "video": "🎬 Video",
    "document": "📎 Document",
    "sticker": "🌟 Sticker",
}


def log_incoming_message(payload, message):
    phone = format_phone(message.get("from"))
    message_type = message.get("type")
    whatsapp_message_id = message.get("id")

    # Meta re-delivers the same webhook if we're slow to answer (e.g. while
    # a burst of order templates is going out). Without this, each retry
    # logged the customer's message again — the 4-5x duplicates.
    if whatsapp_message_id and not claim_event(f"wa_in:{whatsapp_message_id}"):
        print(f"Duplicate incoming message {whatsapp_message_id} ignored.")
        return

    media_url = None
    media_mime = None

    if message_type == "text":
        body = message.get("text", {}).get("body", "")
    elif message_type == "button":
        body = message.get("button", {}).get("text", "")
    elif message_type == "interactive":
        interactive = message.get("interactive", {})
        if interactive.get("type") == "button_reply":
            body = interactive.get("button_reply", {}).get("title", "")
        elif interactive.get("type") == "list_reply":
            body = interactive.get("list_reply", {}).get("title", "")
        else:
            body = "[interactive message received]"
    elif message_type == "reaction":
        reaction = message.get("reaction", {}) or {}
        emoji = reaction.get("emoji", "")
        body = emoji if emoji else "[reaction removed]"
    elif message_type in ("image", "audio", "voice", "video", "document", "sticker"):
        # Normalize legacy "voice" payloads into the "audio" bucket.
        media_obj = message.get(message_type, {}) or {}
        bucket_subdir = "audio" if message_type == "voice" else message_type
        media_id = media_obj.get("id")
        caption = (media_obj.get("caption") or "").strip()
        filename = (media_obj.get("filename") or "").strip()

        content, fetched_mime = fetch_whatsapp_media(media_id)
        media_mime = fetched_mime or media_obj.get("mime_type")
        if content:
            media_url = upload_media_to_storage(bucket_subdir, media_id, content, media_mime)
        # Body is the preview text shown in the conversation list. Prefer
        # an actual caption / filename; fall back to a friendly icon.
        body = caption or filename or _MEDIA_TYPE_ICONS.get(message_type, "📎 Attachment")
    else:
        body = f"[{message_type} message received]"

    customer = get_or_create_customer(name=None, phone=phone)
    conversation = get_or_create_conversation(customer=customer, phone=phone)

    try:
        supabase.table("messages").insert({
            "conversation_id": conversation["id"],
            "whatsapp_message_id": whatsapp_message_id,
            "direction": "incoming",
            "type": message_type,
            "body": body,
            "media_url": media_url,
            "media_mime_type": media_mime,
            "status": "received",
            "raw_payload": payload,
        }).execute()
    except Exception as e:
        # Second line of defence: the unique index on incoming
        # whatsapp_message_id (see sql/2026_11_webhook_dedup.sql).
        if _is_unique_violation(e):
            print(f"Duplicate incoming message {whatsapp_message_id} ignored (unique index).")
            return
        raise

    unread_count = conversation.get("unread_count") or 0

    # Intent detection on button replies (always short and the customer's
    # literal tap) is aggressive; on free text we stay conservative so that
    # questions like "can I cancel later?" don't flip the flag.
    normalized = (body or "").strip().lower()
    is_button_tap = message_type in ("button", "interactive")
    if is_button_tap:
        is_cancel_intent = "cancel" in normalized
        is_confirm_intent = (not is_cancel_intent) and "confirm" in normalized
    else:
        is_cancel_intent = (
            normalized in {"cancel", "cancel order", "cancel my order", "no cancel"}
            or normalized.startswith("cancel ")
            or normalized.startswith("please cancel")
            or normalized.startswith("plz cancel")
        )
        is_confirm_intent = False

    update_payload = {
        "last_message": body,
        "last_message_at": "now()",
        "last_customer_message_at": "now()",
        "unread_count": unread_count + 1,
        # If the customer is messaging us, they ARE on WhatsApp -
        # clear any stale "not on WhatsApp" flag from earlier sends.
        "is_not_on_whatsapp": False,
        "updated_at": "now()",
    }
    if is_cancel_intent:
        update_payload["is_cancelled"] = True

    # Decide whether to auto-reply BEFORE we update the row (the snapshot
    # `conversation` is what we had before this incoming message arrived).
    prior_template = (conversation.get("last_template") or "").strip().lower()
    should_auto_reply = (
        is_confirm_intent
        and prior_template not in {
            TEMPLATE_TAG_CONFIRMED,
            TEMPLATE_TAG_FULFILLED,
            TEMPLATE_TAG_BANK_PENDING,  # bank deposits need manual payment verification
        }
    )
    if should_auto_reply:
        # Customer just acknowledged a COD confirmation template — graduate
        # the conversation to the 'confirmed' tag so it stops showing up
        # under the "Confirmation" filter as something needing attention.
        update_payload["last_template"] = TEMPLATE_TAG_CONFIRMED
        update_payload["is_cancelled"] = False

    supabase.table("conversations").update(update_payload).eq("id", conversation["id"]).execute()

    mark_customer_replied(conversation, message_type, body)
    if is_confirm_intent or is_cancel_intent:
        try:
            order = current_order_for_conversation(conversation["id"])
            if order and is_confirm_intent and order["stage"] == "pending" and order.get("payment_method") != "bank":
                set_order_stage(order, "confirmed", "Customer", via="button", sync_conversation=False)
            elif order and is_cancel_intent and order["stage"] in ("pending", "confirmed"):
                set_order_stage(order, "cancelled", "Customer", reason="Customer cancelled on WhatsApp",
                                sync_conversation=False)
        except Exception as e:
            log.warning(f"order stage update from customer reply failed: {e}")

    if should_auto_reply:
        send_confirm_auto_reply(conversation, phone)

    print(
        f"Incoming {message_type} logged."
        + (" Marked cancelled." if is_cancel_intent else "")
        + (" Auto-replied to confirm." if should_auto_reply else "")
    )


# Status ordering so a late 'delivered' webhook can't downgrade a 'read'.
_STATUS_RANK = {
    "queued": 0,
    "sending": 1,
    "sent": 2,
    "delivered": 3,
    "read": 4,
}


def log_message_status(payload, status_event):
    whatsapp_message_id = status_event.get("id")
    status = status_event.get("status")

    if not whatsapp_message_id or not status:
        return

    # The status webhook can arrive before log_outgoing_*_message() has
    # inserted the row, so retry briefly — but only briefly. These sleeps
    # used to add up to 3s per status, and with a burst of order templates
    # (each producing sent/delivered/read) they tied up every PythonAnywhere
    # worker; Meta then timed out on customers' messages and re-sent them.
    # 'sent' is skipped outright: rows are inserted with status 'sent'.
    attempts = 1 if status == "sent" else 3
    message = None
    for attempt in range(attempts):
        message_result = (
            supabase.table("messages")
            .select("id, status, conversation_id")
            .eq("whatsapp_message_id", whatsapp_message_id)
            .limit(1)
            .execute()
        )
        if message_result.data:
            message = message_result.data[0]
            break
        if attempt < attempts - 1:
            time.sleep(0.3)

    if message is None:
        print(f"Status '{status}' received but message not found after retries: {whatsapp_message_id}")
        return

    current_status = message.get("status")
    if status != "failed" and _STATUS_RANK.get(status, -1) <= _STATUS_RANK.get(current_status, -1):
        print(f"Skipping status downgrade {current_status} -> {status} for {whatsapp_message_id}")
    else:
        supabase.table("messages").update({
            "status": status,
        }).eq("id", message["id"]).execute()
        print(f"Message status updated: {current_status or 'unknown'} -> {status}")

    # Failed delivery — check if it's because the recipient isn't on WhatsApp,
    # and if so flag the conversation so the inbox UI shows a clear tag.
    if status == "failed":
        errors = status_event.get("errors") or []
        for err in errors:
            code = err.get("code")
            if code in _NOT_ON_WHATSAPP_ERROR_CODES:
                conv_id = message.get("conversation_id")
                if conv_id:
                    try:
                        supabase.table("conversations").update({
                            "is_not_on_whatsapp": True,
                        }).eq("id", conv_id).execute()
                        print(f"Conversation {conv_id} flagged as not on WhatsApp (error code {code}).")
                        order = current_order_for_conversation(conv_id)
                        if order:
                            change_flags(order, add=["not_on_whatsapp"])
                    except Exception as e:
                        print(f"Could not flag conversation {conv_id}: {e}")
                break

    try:
        supabase.table("message_status_events").insert({
            "message_id": message["id"],
            "whatsapp_message_id": whatsapp_message_id,
            "status": status,
            "raw_payload": payload,
        }).execute()
    except Exception as e:
        print("Could not save status event:", str(e))


# =========================
# SHOPIFY: ORDER CREATED
# =========================

@app.route("/shopify/order-created", methods=["POST"])
def order_created():
    order = request.json or {}
    extracted = extract_order_data(order)

    webhook_id = request.headers.get("X-Shopify-Webhook-Id")
    shopify_order_id = str(order.get("id") or "")
    phone = format_phone(extracted["customer_phone"]) if extracted["customer_phone"] else ""
    order_key = f"create:{shopify_order_id or extracted['order_number']}:{phone}"

    # Pick which template to send based on the chosen payment method.
    # Bank Deposit gets the bank-details template (if configured); everything
    # else falls back to the regular order-confirmation template.
    use_bank_template = bool(BANK_DEPOSIT_TEMPLATE_NAME) and is_bank_deposit_order(order)
    gateways_dbg = order.get("payment_gateway_names") or order.get("gateway")

    print("\n===== NEW SHOPIFY ORDER =====")
    print(json.dumps(extracted, indent=2, ensure_ascii=False))
    print(f"X-Shopify-Webhook-Id: {webhook_id}")
    print(f"Payment gateway: {gateways_dbg} | bank_deposit_path={use_bank_template}")

    with _DEDUP_LOCK:
        if webhook_id and webhook_id in _PROCESSED_WEBHOOK_IDS:
            print("Duplicate webhook id received. Ignored.")
            return "Duplicate webhook ignored", 200
        if order_key in _PROCESSED_ORDER_KEYS:
            print("Duplicate order key received in this process. Ignored.")
            return "Duplicate order ignored", 200
        _remember(_PROCESSED_WEBHOOK_IDS, webhook_id)
        _remember(_PROCESSED_ORDER_KEYS, order_key)

    if not extracted["customer_phone"]:
        print("No customer phone found. WhatsApp not sent.")
        return "OK", 200

    # Cross-worker dedup, claimed BEFORE the (paid) template goes out.
    # Shopify retries if we take >5s; the DB check below only sees the
    # message after it's logged, so a retry arriving mid-send used to
    # send the confirmation template twice.
    claim_key = f"order_created:{shopify_order_id or extracted['order_number']}:{phone}"
    if not claim_event(claim_key):
        print("Order confirmation already claimed by another request. Ignored.")
        return "Duplicate order ignored", 200

    try:
        return _handle_order_created(order, extracted, phone, shopify_order_id, use_bank_template)
    except Exception:
        release_event(claim_key)
        raise


def _handle_order_created(order, extracted, phone, shopify_order_id, use_bank_template):
    # How many orders has this customer (by phone) placed, this one included?
    # Shown in the inbox's Shipping address panel ("1st order", "2nd order"…).
    order_count = record_customer_order(
        phone,
        extracted["order_number"],
        shopify_order_id=shopify_order_id,
        shopify_orders_count=(order.get("customer") or {}).get("orders_count"),
    )
    print(f"Customer order count: {order_count}")

    existing_conversation = (
        supabase.table("conversations")
        .select("id")
        .eq("order_id", extracted["order_number"])
        .eq("phone", phone)
        .limit(1)
        .execute()
    )

    if existing_conversation.data:
        # Conversation exists; block the send if we already sent *any*
        # confirmation-class template (COD or Bank Deposit) for THIS order.
        # Scoped by raw_payload->>order_number because "conversations" rows
        # are reused across a customer's repeat orders (keyed by phone, not
        # order) — without this, a template sent for a customer's earlier
        # order would look like a duplicate for their new one.
        candidate_templates = [t for t in (TEMPLATE_NAME, BANK_DEPOSIT_TEMPLATE_NAME) if t]
        already_sent = (
            supabase.table("messages")
            .select("id")
            .eq("conversation_id", existing_conversation.data[0]["id"])
            .in_("template_name", candidate_templates)
            .eq("raw_payload->>order_number", extracted["order_number"])
            .limit(1)
            .execute()
        )
        if already_sent.data:
            print("Confirmation already sent for this order. Skipping.")
            return "Duplicate ignored", 200

    # Once the template is sent, never let a logging error reach the
    # caller: a 500 would make Shopify retry, and the retry must not be
    # able to release the claim and send (and bill) the template again.
    payment_method = "bank" if use_bank_template else "cod"
    if use_bank_template:
        whatsapp_message_id = send_whatsapp_bank_deposit(extracted)
        if whatsapp_message_id:
            try:
                conversation_id = log_outgoing_bank_deposit_message(extracted, whatsapp_message_id)
                set_conversation_order_count(conversation_id, order_count)
                record_order(extracted, phone, shopify_order_id, payment_method, conversation_id)
            except Exception as e:
                log.exception(f"Bank-deposit template sent but logging failed: {e}")
        else:
            print("WhatsApp bank-deposit template failed. Not logged as outgoing message.")
    else:
        whatsapp_message_id = send_whatsapp_confirmation(extracted)
        if whatsapp_message_id:
            try:
                conversation_id = log_outgoing_order_message(extracted, whatsapp_message_id)
                set_conversation_order_count(conversation_id, order_count)
                record_order(extracted, phone, shopify_order_id, payment_method, conversation_id)
            except Exception as e:
                log.exception(f"Confirmation template sent but logging failed: {e}")
        else:
            print("WhatsApp confirmation failed. Not logged as outgoing message.")

    if not whatsapp_message_id:
        # Previously these orders vanished from the inbox. Now they get a chat
        # flagged "Not on WhatsApp" and land in the call queue.
        conversation_id = log_unsendable_order(extracted, phone)
        set_conversation_order_count(conversation_id, order_count)
        record_order(extracted, phone, shopify_order_id, payment_method, conversation_id,
                     extra_flags=["whatsapp_failed", "not_on_whatsapp"])

    return "OK", 200


# =========================
# SHOPIFY: ORDER FULFILLED
# =========================

@app.route("/shopify/order-fulfilled", methods=["POST"])
def order_fulfilled():
    order = request.json or {}
    extracted = extract_fulfillment_data(order)

    webhook_id = request.headers.get("X-Shopify-Webhook-Id")
    shopify_order_id = str(order.get("id") or "")
    phone = format_phone(extracted["customer_phone"]) if extracted["customer_phone"] else ""

    # Use fulfillment id (if available) so re-fulfillment of split shipments
    # would naturally yield a different key.
    fulfillments = order.get("fulfillments") or []
    latest_fulfillment_id = (fulfillments[-1].get("id") if fulfillments else "") if fulfillments else ""
    fulfillment_key = (
        f"fulfill:{shopify_order_id or extracted['order_number']}:{latest_fulfillment_id}:{phone}"
    )

    print("\n===== SHOPIFY ORDER FULFILLED =====")
    print(json.dumps(extracted, indent=2, ensure_ascii=False))
    print(f"X-Shopify-Webhook-Id: {webhook_id}")

    with _DEDUP_LOCK:
        if webhook_id and webhook_id in _PROCESSED_WEBHOOK_IDS:
            print("Duplicate webhook id received. Ignored.")
            return "Duplicate webhook ignored", 200
        if fulfillment_key in _PROCESSED_FULFILLMENT_KEYS:
            print("Duplicate fulfillment key received in this process. Ignored.")
            return "Duplicate fulfillment ignored", 200
        _remember(_PROCESSED_WEBHOOK_IDS, webhook_id)
        _remember(_PROCESSED_FULFILLMENT_KEYS, fulfillment_key)

    if not extracted["customer_phone"]:
        print("No customer phone found. WhatsApp not sent.")
        return "OK", 200

    # Cross-worker dedup claimed before the template goes out (see order_created).
    claim_key = f"order_fulfilled:{shopify_order_id or extracted['order_number']}:{latest_fulfillment_id}:{phone}"
    if not claim_event(claim_key):
        print("Fulfillment notice already claimed by another request. Ignored.")
        return "Duplicate fulfillment ignored", 200

    try:
        return _handle_order_fulfilled(extracted, phone)
    except Exception:
        release_event(claim_key)
        raise


def _handle_order_fulfilled(extracted, phone):
    try:
        rows = (
            supabase.table("orders").select("*").eq("phone", phone)
            .eq("order_number", extracted["order_number"]).limit(1).execute()
        ).data or []
        if rows and rows[0]["stage"] not in ("shipped", "delivered", "returned"):
            update_order(rows[0]["id"], {"tracking_number": _real_tracking_number(extracted.get("tracking_number"))})
            set_order_stage(rows[0], "shipped", "Shopify", sync_conversation=False)
    except Exception as e:
        log.warning(f"order shipped update failed: {e}")

    # DB-level dedup: have we already sent a fulfillment template for THIS
    # order? Scoped by raw_payload->>order_number — "conversations" rows are
    # reused across a customer's repeat orders (keyed by phone, not order),
    # so without this, an order_dispatched message logged for a customer's
    # earlier order would make a genuinely new order's dispatch look like a
    # duplicate and get silently skipped.
    existing_conversation = (
        supabase.table("conversations")
        .select("id")
        .eq("order_id", extracted["order_number"])
        .eq("phone", phone)
        .limit(1)
        .execute()
    )
    if existing_conversation.data:
        already_sent = (
            supabase.table("messages")
            .select("id")
            .eq("conversation_id", existing_conversation.data[0]["id"])
            .eq("template_name", FULFILLMENT_TEMPLATE_NAME)
            .eq("raw_payload->>order_number", extracted["order_number"])
            .limit(1)
            .execute()
        )
        if already_sent.data:
            print("Fulfillment notice already sent for this order. Skipping.")
            return "Duplicate ignored", 200

    whatsapp_message_id = send_whatsapp_fulfillment(extracted)

    if whatsapp_message_id:
        # Never 500 after a successful send (see order_created).
        try:
            log_outgoing_fulfillment_message(extracted, whatsapp_message_id)
        except Exception as e:
            log.exception(f"Fulfillment template sent but logging failed: {e}")
    else:
        print("WhatsApp fulfillment failed. Not logged as outgoing message.")

    return "OK", 200


# =========================
# WHATSAPP WEBHOOK
# =========================

@app.route("/whatsapp/webhook", methods=["GET"])
def verify_whatsapp_webhook():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if mode == "subscribe" and token == WHATSAPP_VERIFY_TOKEN:
        print("WhatsApp webhook verified.")
        return challenge, 200

    print("Webhook verification failed.")
    return "Forbidden", 403


@app.route("/whatsapp/webhook", methods=["POST"])
def whatsapp_webhook():
    payload = request.json

    print("\n===== WHATSAPP WEBHOOK RECEIVED =====")
    print(json.dumps(payload, indent=2, ensure_ascii=False))

    try:
        entries = payload.get("entry", [])
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})

                if "messages" in value:
                    for message in value.get("messages", []):
                        log_incoming_message(payload, message)

                if "statuses" in value:
                    for status_event in value.get("statuses", []):
                        log_message_status(payload, status_event)

        return "OK", 200
    except Exception as e:
        print("Webhook error:", str(e))
        return "OK", 200


# =========================
# SEND CUSTOM MESSAGE
# =========================

def _meta_error_text(response):
    """Surface Meta's actual error message so the frontend can show
    something useful instead of a generic 'Failed to send'."""
    try:
        err = (response.json() or {}).get("error") or {}
        code = err.get("code")
        details = (err.get("error_data") or {}).get("details") or ""
        return " | ".join(p for p in [
            f"#{code}" if code is not None else "",
            err.get("message") or "",
            details,
        ] if p) or response.text
    except Exception:
        return response.text


@app.route("/send-message", methods=["POST", "OPTIONS"])
@require_staff()
def send_message(staff):
    """Send a free-form text reply from the inbox, recorded as sent by the
    logged-in staff member.

    Every failure path returns JSON (with CORS headers) so the browser shows
    the real error instead of a generic 'CORS error'."""
    data = request.get_json(silent=True) or {}
    phone = format_phone(data.get("phone"))
    message = (data.get("message") or "").strip()
    conversation_id = data.get("conversation_id")
    if not phone or not message or not conversation_id:
        return jsonify({
            "success": False,
            "error": "phone, message and conversation_id are required",
        }), 400

    ok, result, status = deliver_text(
        staff, conversation_id, phone, message,
        quick_reply_id=data.get("quick_reply_id"),
        order_id=data.get("order_id"),
    )
    if not ok:
        return jsonify({"success": False, "error": result}), status
    return jsonify({"success": True, "whatsapp_message_id": result}), 200


# =========================
# SEND MEDIA (images, videos, voice notes, documents)
# =========================

# What the WhatsApp Cloud API accepts per message type, and the max size.
# Anything outside these lists is either converted (voice notes → OGG/Opus)
# or sent as a document so the customer still receives the file.
_WA_MEDIA_RULES = {
    "image": ({"image/jpeg", "image/png"}, 5 * 1024 * 1024),
    "video": ({"video/mp4", "video/3gpp"}, 16 * 1024 * 1024),
    "audio": ({"audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"}, 16 * 1024 * 1024),
    "document": (None, 100 * 1024 * 1024),
}


def _convert_to_ogg_opus(content):
    """Transcode audio bytes to OGG/Opus with ffmpeg — the format WhatsApp
    renders as a voice note. Browsers like Chrome record WebM, which
    WhatsApp rejects. Returns the new bytes, or None if ffmpeg is missing
    or the conversion fails."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        log.warning("ffmpeg not found; cannot convert voice note to OGG/Opus")
        return None
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in")
        dst = os.path.join(tmp, "out.ogg")
        with open(src, "wb") as f:
            f.write(content)
        try:
            result = subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-i", src, "-vn",
                 "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-ar", "48000", dst],
                capture_output=True,
                timeout=60,
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            log.error(f"ffmpeg conversion error: {e}")
            return None
        if result.returncode != 0 or not os.path.exists(dst):
            log.error(f"ffmpeg conversion failed: {result.stderr.decode(errors='ignore')[:300]}")
            return None
        with open(dst, "rb") as f:
            return f.read()


def _upload_media_to_whatsapp(content, mime_type, filename):
    """Upload bytes to WhatsApp's media store. Returns (media_id, error)."""
    try:
        resp = requests.post(
            f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/media",
            headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"},
            data={"messaging_product": "whatsapp", "type": mime_type},
            files={"file": (filename, content, mime_type)},
            timeout=60,
        )
    except requests.exceptions.RequestException as e:
        return None, f"Could not reach WhatsApp API: {type(e).__name__}"
    log.info(f"SEND-MEDIA upload status={resp.status_code} body={resp.text[:300]}")
    if resp.status_code not in (200, 201):
        return None, _meta_error_text(resp)
    media_id = (resp.json() or {}).get("id")
    if not media_id:
        return None, "WhatsApp did not return a media id"
    return media_id, None


@app.route("/send-media", methods=["POST", "OPTIONS"])
@require_staff()
def send_media(staff):
    """Send an image, video, voice note or document from the inbox.

    multipart/form-data fields:
        file             the attachment (required)
        phone            customer phone (required)
        conversation_id  (required)
        caption          optional — shown under images, videos, documents
        voice            "1" when the file is a voice note recorded in the inbox

    Like free-form text, this only works inside the 24-hour window after
    the customer last messaged us."""
    upload = request.files.get("file")
    phone = format_phone(request.form.get("phone"))
    conversation_id = request.form.get("conversation_id")
    caption = (request.form.get("caption") or "").strip()
    is_voice = request.form.get("voice") == "1"

    if not upload or not phone or not conversation_id:
        return jsonify({
            "success": False,
            "error": "file, phone and conversation_id are required",
        }), 400

    content = upload.read()
    if not content:
        return jsonify({"success": False, "error": "The file is empty"}), 400
    mime = (upload.mimetype or mimetypes.guess_type(upload.filename or "")[0] or "application/octet-stream")
    mime = mime.split(";")[0].strip().lower()
    filename = upload.filename or f"attachment{_ext_for_mime(mime)}"

    kind = mime.split("/")[0]
    if kind not in ("image", "video", "audio"):
        kind = "document"

    if kind == "audio":
        allowed = _WA_MEDIA_RULES["audio"][0]
        # Always prefer OGG/Opus for voice notes so WhatsApp shows them as a
        # playable voice message. Other audio is converted only if needed.
        if (is_voice and mime != "audio/ogg") or mime not in allowed:
            converted = _convert_to_ogg_opus(content)
            if converted:
                content, mime = converted, "audio/ogg"
                filename = os.path.splitext(filename)[0] + ".ogg"
            elif mime not in allowed:
                return jsonify({
                    "success": False,
                    "error": f"WhatsApp doesn't accept {mime} audio and it couldn't be converted "
                             f"(ffmpeg unavailable). Try recording in Safari/Firefox or send an MP3.",
                }), 400
    elif kind in ("image", "video") and mime not in _WA_MEDIA_RULES[kind][0]:
        # e.g. WebP/HEIC images or WebM/MOV videos — WhatsApp won't render
        # them inline, but they still go through as a downloadable file.
        kind = "document"

    max_bytes = _WA_MEDIA_RULES[kind][1]
    if len(content) > max_bytes:
        return jsonify({
            "success": False,
            "error": f"File is too large for a WhatsApp {kind} "
                     f"({len(content) / 1048576:.1f} MB, max {max_bytes // 1048576} MB)",
        }), 400

    log.info(f"SEND-MEDIA kind={kind} mime={mime} size={len(content)} phone={phone[-4:]}")

    media_id, err = _upload_media_to_whatsapp(content, mime, filename)
    if err:
        return jsonify({"success": False, "error": err}), 400

    media_obj = {"id": media_id}
    if caption and kind in ("image", "video", "document"):
        media_obj["caption"] = caption
    if kind == "document":
        media_obj["filename"] = filename

    try:
        response = requests.post(
            f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages",
            headers={
                "Authorization": f"Bearer {WHATSAPP_TOKEN}",
                "Content-Type": "application/json",
            },
            json={
                "messaging_product": "whatsapp",
                "to": phone,
                "type": kind,
                kind: media_obj,
            },
            timeout=20,
        )
    except requests.exceptions.RequestException as e:
        log.error(f"SEND-MEDIA network error: {type(e).__name__}: {e}")
        return jsonify({
            "success": False,
            "error": f"Could not reach WhatsApp API: {type(e).__name__}",
        }), 502

    log.info(f"SEND-MEDIA send status={response.status_code} body={response.text[:300]}")
    if response.status_code not in (200, 201):
        return jsonify({"success": False, "error": _meta_error_text(response)}), 400

    try:
        result = response.json()
    except Exception:
        result = {}
    whatsapp_message_id = (result.get("messages") or [{}])[0].get("id")

    # Keep our own copy in Supabase Storage so the inbox can render it.
    media_url = upload_media_to_storage(kind, media_id, content, mime)
    message_type = "audio" if kind == "audio" else kind
    preview = caption or (filename if kind == "document" else _MEDIA_TYPE_ICONS.get(message_type, "📎 Attachment"))

    record_staff_send(staff, conversation_id, message_type, preview, whatsapp_message_id, result,
                      media_url=media_url, media_mime=mime, kind="message",
                      summary=f"Sent {message_type}" + (f": {caption[:60]}" if caption else ""))

    return jsonify({
        "success": True,
        "whatsapp_message_id": whatsapp_message_id,
        "media_url": media_url,
    }), 200


# =========================
# QUICK REPLIES (saved messages for the inbox composer)
# =========================

# Shown when the quick_replies table hasn't been created yet, so the
# feature works out of the box. The same messages are seeded by
# sql/2026_10_quick_replies_and_order_count.sql.
_DEFAULT_QUICK_REPLIES = [
    {
        "title": "Please wait",
        "body": "Thank you for reaching out to AstroLamps! ✨ A member of our team will get back to you shortly. We appreciate your patience.",
    },
    {
        "title": "Payment received",
        "body": "Thank you! We've received your payment and your order has been marked as paid. ✅\n\nIt will be delivered within 3–4 working days, InshaAllah. We appreciate your trust in AstroLamps.",
    },
    {
        "title": "Advance payment (refused order)",
        "body": "We noticed that your previous order was not received at the time of delivery. To process this new order, we kindly require an advance payment of PKR 200.\n\nBank details:\nAccount Title: ABDUL HANNAN\nBank: Askari Bank Limited, Lahore\nAccount Number: 01410320215569\nIBAN: PK75ASCM0001410320215569\n\nKindly share the transaction screenshot here once the payment is done. Thank you for your understanding.",
    },
    {
        "title": "Bank details",
        "body": "Please find our bank details below:\n\nAccount Title: ABDUL HANNAN\nBank: Askari Bank Limited, Lahore\nAccount Number: 01410320215569\nIBAN: PK75ASCM0001410320215569\n\nKindly share a screenshot here once the payment has been made.",
    },
    {
        "title": "Refund & warranty policy",
        "body": "All AstroLamps lamps come with a 30-day refund policy and a 1-year replacement warranty, so you can order with complete peace of mind. 🛡️\n\nIf you face any issue with your product, please don't hesitate to reach out. Our team is always here to help.",
    },
]


def _clean_quick_reply(data):
    title = (data.get("title") or "").strip()[:80]
    body = (data.get("body") or "").strip()[:4096]
    return title, body


def _quick_reply_category(data):
    return (data.get("category") or "").strip()[:40] or "General"


@app.route("/quick-replies", methods=["GET", "POST", "OPTIONS"])
@require_staff()
def quick_replies(staff):

    if request.method == "GET":
        try:
            # Most-used first, so the replies the team actually sends are on top.
            rows = (
                supabase.table("quick_replies")
                .select("*")
                .order("use_count", desc=True)
                .order("sort_order")
                .execute()
            )
            return jsonify({"success": True, "persisted": True, "quick_replies": rows.data or []}), 200
        except Exception as e:
            log.warning(f"quick_replies table unavailable, serving defaults: {e}")
            defaults = [
                {"id": f"default-{i}", **qr} for i, qr in enumerate(_DEFAULT_QUICK_REPLIES, 1)
            ]
            return jsonify({"success": True, "persisted": False, "quick_replies": defaults}), 200

    title, body = _clean_quick_reply(request.get_json(silent=True) or {})
    if not title or not body:
        return jsonify({"success": False, "error": "title and body are required"}), 400
    try:
        last = (
            supabase.table("quick_replies")
            .select("sort_order")
            .order("sort_order", desc=True)
            .limit(1)
            .execute()
        )
        next_order = ((last.data or [{}])[0].get("sort_order") or 0) + 1
        created = supabase.table("quick_replies").insert({
            "title": title,
            "body": body,
            "category": _quick_reply_category(request.get_json(silent=True) or {}),
            "sort_order": next_order,
        }).execute()
        log_activity(staff, "quick_reply", f"Added quick reply “{title}”")
    except Exception as e:
        log.error(f"quick_replies insert failed: {e}")
        return jsonify({
            "success": False,
            "error": "Could not save. Make sure the quick_replies table exists in Supabase "
                     "(run sql/2026_10_quick_replies_and_order_count.sql).",
        }), 500
    return jsonify({"success": True, "quick_reply": (created.data or [None])[0]}), 201


@app.route("/quick-replies/<reply_id>", methods=["PUT", "DELETE", "OPTIONS"])
@require_staff()
def quick_reply_item(reply_id, staff):
    try:
        if request.method == "DELETE":
            deleted = supabase.table("quick_replies").delete().eq("id", reply_id).execute()
            if not deleted.data:
                return jsonify({"success": False, "error": "quick reply not found"}), 404
            log_activity(staff, "quick_reply", f"Deleted quick reply “{deleted.data[0].get('title')}”")
            return jsonify({"success": True}), 200

        title, body = _clean_quick_reply(request.get_json(silent=True) or {})
        if not title or not body:
            return jsonify({"success": False, "error": "title and body are required"}), 400
        updated = (
            supabase.table("quick_replies")
            .update({"title": title, "body": body, "category": _quick_reply_category(request.get_json(silent=True) or {})})
            .eq("id", reply_id)
            .execute()
        )
    except Exception as e:
        log.error(f"quick_replies {request.method} failed for {reply_id}: {e}")
        return jsonify({
            "success": False,
            "error": "Could not save. Make sure the quick_replies table exists in Supabase "
                     "(run sql/2026_10_quick_replies_and_order_count.sql).",
        }), 500
    if not updated.data:
        return jsonify({"success": False, "error": "quick reply not found"}), 404
    return jsonify({"success": True, "quick_reply": updated.data[0]}), 200


# =========================
# CONVERSATION STATUS (manual overrides from the inbox UI)
# =========================

@app.route("/conversations/<conversation_id>/set-status", methods=["POST", "OPTIONS"])
@require_staff()
def set_conversation_status(conversation_id, staff):
    """Let the merchant flip a conversation's tag from the inbox dropdown.

    Body: { "last_template": "paid" | "bank_pending" | null,
            "is_cancelled": true | false }   (each field optional)
    """
    data = request.get_json(silent=True) or {}

    update = {"updated_at": "now()"}
    if "last_template" in data:
        new_tag = data.get("last_template")
        if new_tag not in _MANUALLY_SETTABLE_TAGS:
            return jsonify({"success": False, "error": f"tag '{new_tag}' is not manually settable"}), 400
        update["last_template"] = new_tag
        # Setting paid implicitly means the conversation is not cancelled.
        if new_tag == TEMPLATE_TAG_PAID:
            update["is_cancelled"] = False
    if "is_cancelled" in data:
        update["is_cancelled"] = bool(data["is_cancelled"])

    try:
        result = (
            supabase.table("conversations")
            .update(update)
            .eq("id", conversation_id)
            .execute()
        )
    except Exception as e:
        print(f"set_conversation_status DB error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

    if not result.data:
        return jsonify({"success": False, "error": "conversation not found"}), 404

    # Keep the chat's latest order in step with the tag the agent picked.
    tag_to_stage = {
        TEMPLATE_TAG_CONFIRMATION: ("pending", None), TEMPLATE_TAG_BANK_PENDING: ("pending", None),
        TEMPLATE_TAG_CONFIRMED: ("confirmed", "manual"), TEMPLATE_TAG_PAID: ("confirmed", "payment"),
        TEMPLATE_TAG_FULFILLED: ("shipped", None),
    }
    label = "status cleared"
    try:
        order = current_order_for_conversation(conversation_id)
        if update.get("is_cancelled"):
            label = "Cancelled"
            if order and order["stage"] != "cancelled":
                set_order_stage(order, "cancelled", staff.get("name"), reason="Marked cancelled in inbox",
                                sync_conversation=False)
        elif update.get("last_template") in tag_to_stage:
            stage, via = tag_to_stage[update["last_template"]]
            label = update["last_template"].replace("_", " ").title()
            if order and order["stage"] != stage:
                set_order_stage(order, stage, staff.get("name"), via=via, sync_conversation=False)
    except Exception as e:
        log.warning(f"order sync after set-status failed: {e}")
    log_activity(staff, "status", f"Changed chat status → {label}", conversation_id=conversation_id)

    return jsonify({"success": True, "conversation": result.data[0]}), 200


def _purge_conversations(conversation_ids):
    """Delete one or more conversations and all of their dependent rows.

    Order matters: message_status_events → messages → conversations.
    We do it explicitly so this works regardless of whether the FK columns
    in Supabase were created with ON DELETE CASCADE."""
    ids = [str(cid) for cid in conversation_ids if cid]
    if not ids:
        return 0

    message_ids = []
    msgs = (
        supabase.table("messages")
        .select("id")
        .in_("conversation_id", ids)
        .execute()
    )
    if msgs.data:
        message_ids = [m["id"] for m in msgs.data]

    if message_ids:
        # Some installs don't have a message_status_events table; ignore if absent.
        try:
            supabase.table("message_status_events").delete().in_("message_id", message_ids).execute()
        except Exception as e:
            log.warning(f"delete message_status_events skipped: {e}")
        supabase.table("messages").delete().in_("conversation_id", ids).execute()

    deleted = supabase.table("conversations").delete().in_("id", ids).execute()
    return len(deleted.data or [])


@app.route("/conversations/<conversation_id>", methods=["DELETE", "OPTIONS"])
@require_staff()
def delete_conversation(conversation_id, staff):
    """Hard-delete a single conversation and its messages.

    Use the bulk endpoint for multi-row deletes from the inbox UI's
    Select mode — it's one round trip instead of N."""
    try:
        count = _purge_conversations([conversation_id])
    except Exception as e:
        log.exception(f"delete_conversation failed for {conversation_id}: {e}")
        return jsonify({"success": False, "error": str(e)}), 500
    if count == 0:
        return jsonify({"success": False, "error": "conversation not found"}), 404
    log_activity(staff, "delete", "Deleted a conversation", meta={"conversation_id": conversation_id})
    return jsonify({"success": True, "deleted": count}), 200


@app.route("/conversations/bulk-delete", methods=["POST", "OPTIONS"])
@require_staff()
def bulk_delete_conversations(staff):
    """Hard-delete multiple conversations in one request.

    Body: { "ids": ["uuid-1", "uuid-2", ...] }
    Returns: { "success": true, "deleted": N }"""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "error": "ids (non-empty list) required"}), 400
    # Soft safety cap — the inbox UI is unlikely to ever batch more than a
    # few hundred and Postgres prefers many smaller IN-clauses over one huge.
    if len(ids) > 500:
        return jsonify({"success": False, "error": "max 500 ids per request"}), 400
    try:
        count = _purge_conversations(ids)
    except Exception as e:
        log.exception(f"bulk_delete_conversations failed: {e}")
        return jsonify({"success": False, "error": str(e)}), 500
    log_activity(staff, "delete", f"Deleted {count} conversations", meta={"ids": ids})
    return jsonify({"success": True, "deleted": count}), 200


# =========================
# ORDER WORKFLOW (phase 1)
# =========================
#
# One `orders` row per Shopify order, with a stage the team works through:
#   pending → confirmed / cancelled → shipped (→ delivered / returned later)
# Calls, notes, follow-ups and every staff action are recorded so the owner
# can see who did what. Nothing here sends paid WhatsApp templates; the only
# messages sent are free-form replies the agent chooses to send.

PKT = timezone(timedelta(hours=5))
CALLING_HOURS = (18, 21)              # 6pm–9pm PKT
UNREACHABLE_AFTER_ATTEMPTS = 3
FIRST_RETRY_DELAY = timedelta(hours=2)

# Working days to deliver, by city (used in the "Payment received" message
# and the {days} quick-reply variable).
DELIVERY_DAYS = [
    ("1-2", ["lahore"]),
    ("2-3", ["karachi", "islamabad", "rawalpindi", "faisalabad", "multan", "gujranwala",
             "sialkot", "peshawar", "hyderabad", "sargodha", "bahawalpur", "sheikhupura"]),
]
DEFAULT_DELIVERY_DAYS = "3-4"

PAYMENT_RECEIVED_TEXT = (
    "Thank you! We've received your payment and your order has been marked as paid. ✅\n\n"
    "It will be delivered within {days} working days, InshaAllah. "
    "We appreciate your trust in AstroLamps."
)

CANCEL_REASONS = [
    "Changed mind", "Ordered by mistake", "Price / budget", "Delivery time too long",
    "Ordered elsewhere", "Fake / prank order", "Duplicate order", "Unreachable",
    "Refused advance payment", "Other",
]

CALL_OUTCOMES = {
    "confirmed": "Confirmed on call",
    "no_answer": "No answer",
    "busy": "Busy / phone off",
    "call_back": "Asked to call back",
    "wrong_number": "Wrong number",
    "address_corrected": "Address corrected",
    "cancelled": "Cancelled on call",
}

FLAG_LABELS = {
    "not_on_whatsapp": "Not on WhatsApp",
    "address_incomplete": "Address incomplete",
    "village_address": "Village address",
    "no_city": "City missing",
    "invalid_phone": "Invalid phone",
    "address_issue": "Address issue raised",
    "cancel_requested": "Cancellation asked",
    "payment_pending": "Payment pending",
    "unreachable": "Unreachable",
    "wrong_number": "Wrong number",
    "whatsapp_failed": "WhatsApp send failed",
    "refused_before": "Refused before",
    "important": "Important",
}
_ADDRESS_FLAGS = {"address_incomplete", "village_address", "no_city", "address_issue"}

_LOCALITY_RE = re.compile(
    r"\b(house|h\s*#|h\.?\s*no|home|street|st\b|st#|gali|galli|block|sector|phase|road|rd\b|plot|flat|"
    r"apartment|apt|floor|mohalla|muhalla|mohallah|near|nearby|opposite|opp|behind|town|colony|society|"
    r"scheme|chowk|bazar|bazaar|market|masjid|mosque|school|hospital|park|plaza|tower|lane|avenue|ave\b|"
    r"villas?|cantt|dha|bahria|model|garden|city|nagar|abad|pura|pur\b|wala\b|kot\b)"
)
_VILLAGE_RE = re.compile(
    r"\b(village|vill\b|vpo|goth|chak|basti|moza|mouza|mauza|tehsil|teh\b|p/?o\b|post\s*office|dakhana|dak\s*khana)\b"
)
# Customer messages that don't need an answer ("ok", "thanks", 👍 …).
_ACK_RE = re.compile(
    r"^(ok+|okay|okk+|oky|okok|ok sir|sure|alright|perfect|done|thanks?|thank ?you|thankyou|ty|jazak\S*|"
    r"👍\S*|great|nice|good|fine|theek|thik|acha|jee|ji)\W{0,3}( ?(thanks?|thank ?you|thankyou|sir|bhai|g|ji|jee))?\W{0,3}$"
)


def is_ack_message(text):
    return bool(_ACK_RE.match((text or "").strip().lower()))


def delivery_days_for(city):
    c = (city or "").strip().lower()
    for days, cities in DELIVERY_DAYS:
        if any(name in c for name in cities):
            return days
    return DEFAULT_DELIVERY_DAYS


def order_flags(phone, address):
    """Automatic warnings for a new order: things the agent should check
    before it ships."""
    flags = []
    if not re.fullmatch(r"923\d{9}", phone or ""):
        flags.append("invalid_phone")
    a = address or {}
    line = " ".join(filter(None, [a.get("address1"), a.get("address2")])).strip().lower()
    if _VILLAGE_RE.search(line):
        flags.append("village_address")
    has_digit = bool(re.search(r"\d", line))
    if len(line) < 10 or (not has_digit and (len(line.split()) < 3 or not _LOCALITY_RE.search(line))):
        flags.append("address_incomplete")
    if not (a.get("city") or "").strip():
        flags.append("no_city")
    return flags


def now_utc():
    return datetime.now(timezone.utc)


def next_call_slot(after):
    """Earliest moment at/after `after` that falls inside calling hours."""
    local = after.astimezone(PKT)
    start = local.replace(hour=CALLING_HOURS[0], minute=0, second=0, microsecond=0)
    end = local.replace(hour=CALLING_HOURS[1], minute=0, second=0, microsecond=0)
    if local < start:
        return start
    if local < end:
        return local
    return start + timedelta(days=1)


def call_retry_time(now, attempts):
    """No answer: try again 2h later the first time, then next day's
    calling hours."""
    if attempts <= 1:
        return next_call_slot(now + FIRST_RETRY_DELAY)
    tomorrow = (now.astimezone(PKT) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return next_call_slot(tomorrow)


def _fmt_pkt(dt_value):
    return dt_value.astimezone(PKT).strftime("%d %b %I:%M %p")


def get_order(order_id):
    rows = supabase.table("orders").select("*").eq("id", order_id).limit(1).execute().data or []
    return rows[0] if rows else None


def current_order_for_conversation(conversation_id):
    if not conversation_id:
        return None
    rows = (
        supabase.table("orders").select("*").eq("conversation_id", conversation_id)
        .order("order_created_at", desc=True).limit(1).execute()
    ).data or []
    return rows[0] if rows else None


def update_order(order_id, fields):
    fields = dict(fields, updated_at=now_utc().isoformat())
    rows = supabase.table("orders").update(fields).eq("id", order_id).execute().data or []
    return rows[0] if rows else None


def change_flags(order, add=(), remove=()):
    flags = [f for f in (order.get("flags") or []) if f not in set(remove)]
    for f in add:
        if f not in flags:
            flags.append(f)
    if flags == (order.get("flags") or []):
        return order
    return update_order(order["id"], {"flags": flags}) or order


def close_followups(order_id=None, conversation_id=None, kinds=None, by_name="System"):
    try:
        q = supabase.table("followups").update({
            "done_at": now_utc().isoformat(), "done_by_name": by_name,
        }).is_("done_at", "null")
        if order_id:
            q = q.eq("order_id", order_id)
        if conversation_id:
            q = q.eq("conversation_id", conversation_id)
        if kinds:
            q = q.in_("kind", list(kinds))
        q.execute()
    except Exception as e:
        log.warning(f"close_followups failed: {e}")


def create_followup(conversation_id, order_id, kind, due_at, note=None, by_name="System", auto=False):
    # One open follow-up per order and kind: a new one replaces the old.
    if order_id and kind in ("call", "awaiting_customer"):
        close_followups(order_id=order_id, kinds=[kind], by_name="Rescheduled")
    rows = supabase.table("followups").insert({
        "conversation_id": conversation_id,
        "order_id": order_id,
        "kind": kind,
        "due_at": due_at.isoformat(),
        "note": note,
        "auto": auto,
        "created_by_name": by_name,
    }).execute().data or []
    return rows[0] if rows else None


def set_order_stage(order, stage, by_name, via=None, reason=None, sync_conversation=True):
    """Move an order to a new stage and keep the chat's status tag in step
    (when this is the chat's latest order)."""
    fields = {"stage": stage, "stage_changed_at": now_utc().isoformat(), "stage_changed_by": by_name}
    if stage == "confirmed":
        fields["confirmed_via"] = via or "manual"
        fields["cancel_reason"] = None
    elif stage == "cancelled":
        fields["cancel_reason"] = reason
    elif stage == "pending":
        fields["cancel_reason"] = None
        fields["confirmed_via"] = None
    flags = [f for f in (order.get("flags") or [])
             if not (stage in ("confirmed", "shipped") and f in ("cancel_requested", "payment_pending", "unreachable"))]
    fields["flags"] = flags
    updated = update_order(order["id"], fields) or dict(order, **fields)

    if stage in ("confirmed", "cancelled", "shipped", "delivered", "returned"):
        close_followups(order_id=order["id"], kinds=["call", "awaiting_customer"], by_name=by_name)

    conv_id = order.get("conversation_id")
    if sync_conversation and conv_id:
        latest = current_order_for_conversation(conv_id)
        if latest and latest["id"] == order["id"]:
            conv = {"updated_at": "now()"}
            if stage == "pending":
                conv.update(last_template=TEMPLATE_TAG_BANK_PENDING if order.get("payment_method") == "bank"
                            else TEMPLATE_TAG_CONFIRMATION, is_cancelled=False)
            elif stage == "confirmed":
                conv.update(last_template=TEMPLATE_TAG_PAID if via == "payment" else TEMPLATE_TAG_CONFIRMED,
                            is_cancelled=False)
            elif stage == "cancelled":
                conv.update(is_cancelled=True)
            elif stage == "shipped":
                conv.update(last_template=TEMPLATE_TAG_FULFILLED, is_cancelled=False)
            try:
                supabase.table("conversations").update(conv).eq("id", conv_id).execute()
            except Exception as e:
                log.warning(f"conversation sync for order {order['id']} failed: {e}")
    return updated


_REFUSAL_MESSAGE_PATTERNS = ("%refused to receive%", "%previous order was not received%")


def customer_refused_before(phone):
    """True if this customer had an order returned (marked in the inbox),
    or was already asked for an advance because of a refused order."""
    try:
        returned = (
            supabase.table("orders").select("id").eq("phone", phone).eq("stage", "returned").limit(1).execute()
        ).data
        if returned:
            return True
        conv_ids = [c["id"] for c in (
            supabase.table("conversations").select("id").eq("phone", phone).execute().data or [])]
        for pattern in _REFUSAL_MESSAGE_PATTERNS:
            if conv_ids and (
                supabase.table("messages").select("id").in_("conversation_id", conv_ids)
                .eq("direction", "outgoing").ilike("body", pattern).limit(1).execute()
            ).data:
                return True
    except Exception as e:
        log.warning(f"customer_refused_before failed: {e}")
    return False


def record_order(extracted, phone, shopify_order_id, payment_method, conversation_id, extra_flags=()):
    """Create (or refresh) the orders row for a Shopify order. Never raises."""
    try:
        address = extracted.get("shipping_address") or {}
        flags = order_flags(phone, address) + list(extra_flags)
        if customer_refused_before(phone):
            flags.append("refused_before")
        existing = (
            supabase.table("orders").select("*").eq("phone", phone)
            .eq("order_number", extracted["order_number"]).limit(1).execute()
        ).data or []
        if existing:
            order = existing[0]
            fields = {}
            if conversation_id and not order.get("conversation_id"):
                fields["conversation_id"] = conversation_id
            if extra_flags:
                fields["flags"] = sorted(set((order.get("flags") or []) + list(extra_flags)))
            return update_order(order["id"], fields) if fields else order
        rows = supabase.table("orders").insert({
            "shopify_order_id": str(shopify_order_id) if shopify_order_id else None,
            "order_number": extracted["order_number"],
            "phone": phone,
            "customer_name": extracted.get("customer_name"),
            "conversation_id": conversation_id,
            "total": _parse_amount(extracted.get("total_price")),
            "items_text": extracted.get("products_text"),
            "payment_method": payment_method,
            "shipping_address": address or None,
            "city": address.get("city"),
            "flags": flags,
            "order_created_at": now_utc().isoformat(),
        }).execute().data or []
        return rows[0] if rows else None
    except Exception as e:
        log.warning(f"record_order failed for {extracted.get('order_number')}: {e}")
        return None


def log_unsendable_order(extracted, phone):
    """The confirmation template couldn't be sent (number not on WhatsApp,
    invalid, …). Still create the chat so the order shows up in the inbox
    and the call queue instead of silently disappearing."""
    try:
        customer = get_or_create_customer(name=extracted["customer_name"], phone=phone)
        conversation = get_or_create_conversation(
            customer=customer, phone=phone,
            customer_name=extracted["customer_name"], order_id=extracted["order_number"],
        )
        conv_update = {
            "last_message": f"⚠️ Order {extracted['order_number']}: confirmation could not be sent on WhatsApp",
            "last_message_at": "now()",
            "last_template": TEMPLATE_TAG_CONFIRMATION,
            "is_not_on_whatsapp": True,
            "is_cancelled": False,
            "updated_at": "now()",
        }
        if extracted.get("shipping_address"):
            conv_update["shipping_address"] = extracted["shipping_address"]
        supabase.table("conversations").update(conv_update).eq("id", conversation["id"]).execute()
        return conversation["id"]
    except Exception as e:
        log.warning(f"log_unsendable_order failed: {e}")
        return None


def mark_customer_replied(conversation, message_type, body):
    """Track whether a chat is waiting for our reply, and close 'waiting
    for customer' follow-ups. Separate from the main update so it can't
    break message logging."""
    try:
        if message_type in ("reaction", "sticker", "unsupported"):
            return
        close_followups(conversation_id=conversation["id"], kinds=["awaiting_customer"], by_name="Customer replied")
        if message_type == "button" or (message_type == "text" and is_ack_message(body)):
            return
        fields = {"needs_reply": True}
        if not conversation.get("needs_reply"):
            fields["waiting_since"] = now_utc().isoformat()
        supabase.table("conversations").update(fields).eq("id", conversation["id"]).execute()
    except Exception as e:
        log.warning(f"mark_customer_replied failed: {e}")


def record_staff_send(staff, conversation_id, msg_type, body, whatsapp_message_id, raw,
                      media_url=None, media_mime=None, quick_reply_id=None, order_id=None,
                      kind="message", summary=None):
    """Bookkeeping after a staff member sends something: store the message
    with who sent it, clear the 'waiting for reply' state, count quick-reply
    usage, and log the action with the response time."""
    conv = {}
    try:
        rows = supabase.table("conversations").select("needs_reply,waiting_since").eq("id", conversation_id).execute().data
        conv = (rows or [{}])[0]
    except Exception:
        pass
    try:
        supabase.table("messages").insert({
            "conversation_id": conversation_id,
            "whatsapp_message_id": whatsapp_message_id,
            "direction": "outgoing",
            "type": msg_type,
            "body": body,
            "media_url": media_url,
            "media_mime_type": media_mime,
            "status": "sent",
            "raw_payload": raw,
            "sent_by": staff.get("user_id"),
            "sent_by_name": staff.get("name"),
        }).execute()
        supabase.table("conversations").update({
            "last_message": body,
            "last_message_at": "now()",
            "unread_count": 0,
            "needs_reply": False,
            "waiting_since": None,
            "updated_at": "now()",
        }).eq("id", conversation_id).execute()
    except Exception as e:
        log.error(f"record_staff_send DB log failed (message was already sent): {e}")

    response_secs = None
    if conv.get("needs_reply") and conv.get("waiting_since"):
        try:
            waited = now_utc() - datetime.fromisoformat(conv["waiting_since"].replace("Z", "+00:00"))
            response_secs = max(0, int(waited.total_seconds()))
        except Exception:
            pass

    qr_title = None
    if quick_reply_id:
        try:
            rows = supabase.table("quick_replies").select("title,use_count").eq("id", quick_reply_id).execute().data
            if rows:
                qr_title = rows[0]["title"]
                supabase.table("quick_replies").update({
                    "use_count": (rows[0].get("use_count") or 0) + 1,
                    "last_used_at": now_utc().isoformat(),
                }).eq("id", quick_reply_id).execute()
        except Exception as e:
            log.warning(f"quick reply usage update failed: {e}")

    log_activity(
        staff, kind,
        summary or (f"Sent quick reply “{qr_title}”" if qr_title else f"Sent: {(body or '')[:80]}"),
        conversation_id=conversation_id, order_id=order_id,
        meta={"type": msg_type, "response_secs": response_secs, "quick_reply": qr_title},
    )


def deliver_text(staff, conversation_id, phone, message, quick_reply_id=None, order_id=None,
                 kind="message", summary=None):
    """Send a free-form WhatsApp text on behalf of a staff member.
    Returns (ok, whatsapp_message_id_or_error, http_status)."""
    url = f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages"
    payload = {"messaging_product": "whatsapp", "to": phone, "type": "text", "text": {"body": message}}
    headers = {"Authorization": f"Bearer {WHATSAPP_TOKEN}", "Content-Type": "application/json"}
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=20)
    except requests.exceptions.Timeout:
        return False, "WhatsApp API timed out. Please try again.", 504
    except requests.exceptions.RequestException as e:
        return False, f"Could not reach WhatsApp API: {type(e).__name__}", 502
    log.info(f"SEND-TEXT by={staff.get('name')} status={response.status_code} body={response.text[:300]}")
    if response.status_code not in (200, 201):
        return False, _meta_error_text(response), 400
    try:
        result = response.json()
    except Exception:
        result = {}
    wamid = (result.get("messages") or [{}])[0].get("id")
    record_staff_send(staff, conversation_id, "text", message, wamid, result,
                      quick_reply_id=quick_reply_id, order_id=order_id, kind=kind, summary=summary)
    return True, wamid, 200


def _conversation(conversation_id):
    rows = supabase.table("conversations").select("*").eq("id", conversation_id).limit(1).execute().data or []
    return rows[0] if rows else None


# ---------- Session / config / team ----------

@app.route("/me", methods=["GET", "OPTIONS"])
@require_staff()
def me(staff):
    return jsonify({"success": True, "staff": staff}), 200


@app.route("/config", methods=["GET", "OPTIONS"])
@require_staff()
def workflow_config(staff):
    return jsonify({
        "success": True,
        "delivery_days": [{"days": d, "cities": c} for d, c in DELIVERY_DAYS],
        "default_delivery_days": DEFAULT_DELIVERY_DAYS,
        "calling_hours": {"start": CALLING_HOURS[0], "end": CALLING_HOURS[1]},
        "unreachable_after_attempts": UNREACHABLE_AFTER_ATTEMPTS,
        "cancel_reasons": CANCEL_REASONS,
        "call_outcomes": CALL_OUTCOMES,
        "flag_labels": FLAG_LABELS,
        "payment_received_text": PAYMENT_RECEIVED_TEXT,
    }), 200


@app.route("/team", methods=["GET", "POST", "OPTIONS"])
@require_staff()
def team(staff):
    if request.method == "GET":
        rows = supabase.table("staff").select("*").order("created_at").execute().data or []
        return jsonify({"success": True, "team": rows}), 200

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()[:60]
    role = data.get("role") if data.get("role") in ("admin", "agent") else "agent"
    if not name:
        return jsonify({"success": False, "error": "Enter a name."}), 400
    rows = supabase.table("staff").insert({"name": name, "role": role}).execute().data or []
    log_activity(staff, "team", f"Added {name} ({role})")
    return jsonify({"success": True, "member": rows[0] if rows else None}), 201


@app.route("/team/<user_id>", methods=["PATCH", "OPTIONS"])
@require_staff()
def team_member(user_id, staff):
    data = request.get_json(silent=True) or {}
    rows = supabase.table("staff").select("*").eq("user_id", user_id).limit(1).execute().data or []
    if not rows:
        return jsonify({"success": False, "error": "Team member not found"}), 404
    member = rows[0]
    fields, changes = {}, []
    if (data.get("name") or "").strip():
        fields["name"] = data["name"].strip()[:60]
        changes.append(f"renamed to {fields['name']}")
    if data.get("role") in ("admin", "agent") and data["role"] != member["role"]:
        fields["role"] = data["role"]
        changes.append(f"role → {data['role']}")
    if "active" in data and bool(data["active"]) != member["active"]:
        fields["active"] = bool(data["active"])
        changes.append("re-activated" if data["active"] else "removed")
    if fields:
        supabase.table("staff").update(fields).eq("user_id", user_id).execute()
    with _STAFF_LOCK:
        _STAFF_CACHE.clear()
    if changes:
        log_activity(staff, "team", f"{member['name']}: {', '.join(changes)}")
    return jsonify({"success": True}), 200


# ---------- Orders ----------

@app.route("/orders/<order_id>/action", methods=["POST", "OPTIONS"])
@require_staff()
def order_action(order_id, staff):
    """All order actions from the inbox, recorded with who did them.

    Body: {"action": ..., ...}
      call         outcome, note?, callback_at? (ISO), address?, reason?
      confirm      —
      cancel       reason
      reopen       —                       (back to pending)
      mark_paid    notify (bool, default true)
      send         message, quick_reply_id?, flag?, followup_hours?
      edit_address address1, address2?, city?
      clear_flag   flag
    """
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    order = get_order(order_id)
    if not order:
        return jsonify({"success": False, "error": "Order not found"}), 404
    who = staff.get("name") or "Staff"
    num = order["order_number"]
    conv_id = order.get("conversation_id")
    warning = None

    if action == "call":
        outcome = data.get("outcome")
        if outcome not in CALL_OUTCOMES:
            return jsonify({"success": False, "error": "Unknown call outcome"}), 400
        attempts = (order.get("call_attempts") or 0) + 1
        order = update_order(order_id, {
            "call_attempts": attempts, "last_call_outcome": outcome, "last_call_at": now_utc().isoformat(),
        }) or order
        close_followups(order_id=order_id, kinds=["call"], by_name=who)
        summary = f"Call {num}: {CALL_OUTCOMES[outcome]} (attempt {attempts})"
        if outcome in ("no_answer", "busy"):
            if attempts >= UNREACHABLE_AFTER_ATTEMPTS:
                order = change_flags(order, add=["unreachable"])
                summary += " → unreachable, consider cancelling"
            else:
                due = call_retry_time(now_utc(), attempts)
                create_followup(conv_id, order_id, "call", due, note=f"Retry call ({CALL_OUTCOMES[outcome]})",
                                by_name=who, auto=True)
                summary += f" → retry {_fmt_pkt(due)}"
        elif outcome == "call_back":
            try:
                due = datetime.fromisoformat((data.get("callback_at") or "").replace("Z", "+00:00"))
                if due.tzinfo is None:
                    due = due.replace(tzinfo=PKT)
            except ValueError:
                return jsonify({"success": False, "error": "Pick a call-back time"}), 400
            create_followup(conv_id, order_id, "call", due, note="Customer asked to call back", by_name=who)
            summary += f" → {_fmt_pkt(due)}"
        elif outcome == "wrong_number":
            order = change_flags(order, add=["wrong_number"])
        if outcome in ("address_corrected", "confirmed") and (data.get("address") or "").strip():
            order = _apply_address_edit(order, {"address1": data["address"].strip()}, who)
        if outcome == "confirmed":
            order = set_order_stage(order, "confirmed", who, via="call")
        elif outcome == "cancelled":
            order = set_order_stage(order, "cancelled", who, reason=data.get("reason") or "Cancelled on call")
            summary += f" ({order.get('cancel_reason')})"
        if (data.get("note") or "").strip():
            _add_note(staff, conv_id, order_id, data["note"].strip())
        log_activity(staff, "call", summary, conversation_id=conv_id, order_id=order_id,
                     meta={"outcome": outcome, "attempt": attempts})

    elif action == "confirm":
        order = set_order_stage(order, "confirmed", who, via="manual")
        log_activity(staff, "stage", f"Confirmed {num}", conversation_id=conv_id, order_id=order_id)

    elif action == "cancel":
        reason = (data.get("reason") or "").strip() or "Other"
        order = set_order_stage(order, "cancelled", who, reason=reason)
        log_activity(staff, "stage", f"Cancelled {num} ({reason})", conversation_id=conv_id, order_id=order_id)

    elif action == "returned":
        order = set_order_stage(order, "returned", who, sync_conversation=False)
        _add_note(staff, conv_id, order_id, f"Order {num} returned / refused at delivery")
        # Any other open order from this customer now needs an advance.
        try:
            others = (
                supabase.table("orders").select("*").eq("phone", order["phone"])
                .in_("stage", ["pending", "confirmed"]).execute()
            ).data or []
            for other in others:
                change_flags(other, add=["refused_before"])
        except Exception as e:
            log.warning(f"refused_before flag on other orders failed: {e}")
        log_activity(staff, "stage", f"Marked {num} returned", conversation_id=conv_id, order_id=order_id)

    elif action == "reopen":
        order = set_order_stage(order, "pending", who)
        log_activity(staff, "stage", f"Reopened {num} (back to pending)", conversation_id=conv_id, order_id=order_id)

    elif action == "mark_paid":
        order = set_order_stage(order, "confirmed", who, via="payment")
        summary = f"Marked {num} paid"
        if data.get("notify", True) and conv_id:
            conv = _conversation(conv_id)
            text = PAYMENT_RECEIVED_TEXT.format(days=delivery_days_for(order.get("city")))
            ok, result, _ = deliver_text(staff, conv_id, conv["phone"], text, order_id=order_id,
                                         kind="message", summary=f"Sent payment received ({num})")
            if ok:
                summary += " & notified customer"
            else:
                warning = f"Marked paid, but the WhatsApp message failed: {result}"
        log_activity(staff, "stage", summary, conversation_id=conv_id, order_id=order_id)

    elif action == "send":
        message = (data.get("message") or "").strip()
        if not message or not conv_id:
            return jsonify({"success": False, "error": "Nothing to send"}), 400
        conv = _conversation(conv_id)
        ok, result, status = deliver_text(staff, conv_id, conv["phone"], message,
                                          quick_reply_id=data.get("quick_reply_id"), order_id=order_id)
        if not ok:
            return jsonify({"success": False, "error": result}), status
        if data.get("flag") in FLAG_LABELS:
            order = change_flags(order, add=[data["flag"]])
        hours = data.get("followup_hours")
        if hours:
            due = now_utc() + timedelta(hours=float(hours))
            create_followup(conv_id, order_id, "awaiting_customer", due,
                            note=f"No reply yet: {FLAG_LABELS.get(data.get('flag'), 'message sent')}",
                            by_name=who, auto=True)

    elif action == "edit_address":
        order = _apply_address_edit(order, data, who)
        log_activity(staff, "address", f"Updated address for {num}", conversation_id=conv_id, order_id=order_id)

    elif action == "important":
        on = bool(data.get("value", True))
        order = change_flags(order, add=["important"] if on else [], remove=[] if on else ["important"])
        log_activity(staff, "flag", f"{'Starred' if on else 'Unstarred'} {num} as important",
                     conversation_id=conv_id, order_id=order_id)

    elif action == "clear_flag":
        flag = data.get("flag")
        order = change_flags(order, remove=[flag])
        log_activity(staff, "flag", f"Cleared “{FLAG_LABELS.get(flag, flag)}” on {num}",
                     conversation_id=conv_id, order_id=order_id)

    else:
        return jsonify({"success": False, "error": f"Unknown action '{action}'"}), 400

    return jsonify({"success": True, "order": get_order(order_id) or order, "warning": warning}), 200


def _apply_address_edit(order, data, who):
    address = dict(order.get("shipping_address") or {})
    for key in ("address1", "address2", "city"):
        if key in data and data[key] is not None:
            address[key] = (data[key] or "").strip() or None
    address = {k: v for k, v in address.items() if v}
    remaining = [f for f in (order.get("flags") or []) if f not in _ADDRESS_FLAGS]
    new_flags = remaining + [f for f in order_flags(order.get("phone"), address)
                             if f in _ADDRESS_FLAGS and f != "address_incomplete"]
    updated = update_order(order["id"], {
        "shipping_address": address, "city": address.get("city"), "flags": sorted(set(new_flags)),
    }) or order
    conv_id = order.get("conversation_id")
    latest = current_order_for_conversation(conv_id) if conv_id else None
    if latest and latest["id"] == order["id"]:
        try:
            supabase.table("conversations").update({"shipping_address": address}).eq("id", conv_id).execute()
        except Exception as e:
            log.warning(f"conversation address sync failed: {e}")
    return updated


# ---------- Notes ----------

def _add_note(staff, conversation_id, order_id, body, customer_level=False):
    phone = None
    if customer_level and conversation_id:
        conv = _conversation(conversation_id)
        phone = conv and conv.get("phone")
    rows = supabase.table("notes").insert({
        "conversation_id": conversation_id,
        "order_id": order_id,
        "phone": phone,
        "body": body,
        "author_id": staff.get("user_id"),
        "author_name": staff.get("name"),
    }).execute().data or []
    if conversation_id:
        try:
            supabase.table("conversations").update({
                "last_note": body,
                "last_note_by": staff.get("name"),
                "last_note_at": now_utc().isoformat(),
            }).eq("id", conversation_id).execute()
        except Exception as e:
            log.warning(f"last_note update failed (run the simplify SQL?): {e}")
    log_activity(staff, "note", f"Note: {body[:80]}", conversation_id=conversation_id, order_id=order_id)
    return rows[0] if rows else None


@app.route("/notes", methods=["POST", "OPTIONS"])
@require_staff()
def create_note(staff):
    data = request.get_json(silent=True) or {}
    body = (data.get("body") or "").strip()
    if not body or not data.get("conversation_id"):
        return jsonify({"success": False, "error": "Write a note first"}), 400
    note = _add_note(staff, data["conversation_id"], data.get("order_id"), body[:2000],
                     customer_level=bool(data.get("customer_level")))
    return jsonify({"success": True, "note": note}), 201


@app.route("/notes/<note_id>", methods=["DELETE", "OPTIONS"])
@require_staff()
def delete_note(note_id, staff):
    rows = supabase.table("notes").select("*").eq("id", note_id).limit(1).execute().data or []
    if not rows:
        return jsonify({"success": False, "error": "Note not found"}), 404
    if rows[0].get("author_id") != staff["user_id"] and staff.get("role") != "admin":
        return jsonify({"success": False, "error": "You can only delete your own notes."}), 403
    supabase.table("notes").delete().eq("id", note_id).execute()
    log_activity(staff, "note", f"Deleted note: {rows[0]['body'][:60]}", conversation_id=rows[0].get("conversation_id"))
    return jsonify({"success": True}), 200


# ---------- Follow-ups ----------

@app.route("/followups", methods=["POST", "OPTIONS"])
@require_staff()
def create_custom_followup(staff):
    data = request.get_json(silent=True) or {}
    try:
        due = datetime.fromisoformat((data.get("due_at") or "").replace("Z", "+00:00"))
        if due.tzinfo is None:
            due = due.replace(tzinfo=PKT)
    except ValueError:
        return jsonify({"success": False, "error": "Pick a date and time"}), 400
    if not data.get("conversation_id"):
        return jsonify({"success": False, "error": "conversation_id is required"}), 400
    kind = data.get("kind") if data.get("kind") in ("call", "custom") else "custom"
    note = (data.get("note") or "").strip() or None
    fu = create_followup(data["conversation_id"], data.get("order_id"), kind, due, note=note,
                         by_name=staff.get("name"))
    log_activity(staff, "followup", f"Reminder set for {_fmt_pkt(due)}" + (f": {note}" if note else ""),
                 conversation_id=data["conversation_id"], order_id=data.get("order_id"))
    return jsonify({"success": True, "followup": fu}), 201


@app.route("/followups/<followup_id>/done", methods=["POST", "OPTIONS"])
@require_staff()
def complete_followup(followup_id, staff):
    rows = (
        supabase.table("followups").update({"done_at": now_utc().isoformat(), "done_by_name": staff.get("name")})
        .eq("id", followup_id).is_("done_at", "null").execute()
    ).data or []
    if rows:
        log_activity(staff, "followup", f"Completed reminder: {rows[0].get('note') or rows[0]['kind']}",
                     conversation_id=rows[0].get("conversation_id"), order_id=rows[0].get("order_id"))
    return jsonify({"success": True}), 200


# ---------- Chats ----------

@app.route("/conversations/<conversation_id>/no-reply-needed", methods=["POST", "OPTIONS"])
@require_staff()
def no_reply_needed(conversation_id, staff):
    supabase.table("conversations").update({"needs_reply": False, "waiting_since": None}).eq("id", conversation_id).execute()
    log_activity(staff, "no_reply", "Marked chat as no reply needed", conversation_id=conversation_id)
    return jsonify({"success": True}), 200


# =========================
# HEALTH CHECK
# =========================

@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "status": "running",
        "app": "AstroLamps WhatsApp Inbox Backend",
        "templates": {
            "order_confirmation": TEMPLATE_NAME,
            "bank_deposit": BANK_DEPOSIT_TEMPLATE_NAME or "(not configured)",
            "order_dispatched": FULFILLMENT_TEMPLATE_NAME,
        },
        "bank_details_configured": bool(BANK_DETAILS_TEXT),
        "bank_deposit_discount_rs": BANK_DEPOSIT_DISCOUNT,
    }), 200


if __name__ == "__main__":
    app.run(port=5000, debug=True)
