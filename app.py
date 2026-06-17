from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import os
import json
import threading
import time
import mimetypes
import requests
from supabase import create_client

load_dotenv()

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

# CORS: lock down origins so prod (Netlify) and dev (Vite) both work, but
# nothing else can hit the API from a browser.
_allowed_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
if FRONTEND_URL:
    _allowed_origins.append(FRONTEND_URL)
CORS(app, origins=_allowed_origins)


# Belt-and-suspenders: ensure CORS headers are on EVERY response, including
# ones from Flask's default error pages. flask-cors normally handles this,
# but error responses occasionally slip through (especially when an
# exception bypasses our custom error handler).
@app.after_request
def _ensure_cors_headers(resp):
    origin = request.headers.get("Origin", "")
    if origin and origin in _allowed_origins:
        resp.headers.setdefault("Access-Control-Allow-Origin", origin)
        resp.headers.setdefault("Vary", "Origin")
        resp.headers.setdefault(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Requested-With",
        )
        resp.headers.setdefault(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        )
    return resp


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
    print(f"===== UNHANDLED EXCEPTION: {type(e).__name__}: {e} =====")
    import traceback
    traceback.print_exc()
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
    TEMPLATE_TAG_PAID,
    TEMPLATE_TAG_BANK_PENDING,
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

def _send_template(template_name, phone, variables):
    """Generic body-only template sender. variables is an ordered list of strings."""
    if not template_name:
        print(f"Cannot send template — template name not configured.")
        return None

    url = f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": format_phone(phone),
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": TEMPLATE_LANGUAGE},
            "components": [
                {
                    "type": "body",
                    "parameters": [{"type": "text", "text": str(v)} for v in variables],
                }
            ],
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
    """Dispatch template — 5 variables:
    name, order#, courier, tracking, items."""
    return _send_template(
        FULFILLMENT_TEMPLATE_NAME,
        data["customer_phone"],
        [
            data["customer_name"],
            _bare_order_number(data["order_number"]),
            data["tracking_company"],
            data["tracking_number"],
            data["products_text"],
        ],
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

    supabase.table("conversations").update({
        "last_message": preview_body,
        "last_message_at": "now()",
        "last_template": TEMPLATE_TAG_CONFIRMATION,
        "is_cancelled": False,
        "updated_at": "now()",
    }).eq("id", conversation["id"]).execute()

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

    supabase.table("conversations").update({
        "last_message": preview_body,
        "last_message_at": "now()",
        "last_template": TEMPLATE_TAG_BANK_PENDING,
        "is_cancelled": False,
        "updated_at": "now()",
    }).eq("id", conversation["id"]).execute()

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

    # Retry the lookup — WhatsApp delivers fast and the status webhook can
    # arrive before log_outgoing_*_message() finishes its Supabase inserts.
    message = None
    for _ in range(6):
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
        time.sleep(0.5)

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
        # confirmation-class template (COD or Bank Deposit) for this order.
        candidate_templates = [t for t in (TEMPLATE_NAME, BANK_DEPOSIT_TEMPLATE_NAME) if t]
        already_sent = (
            supabase.table("messages")
            .select("id")
            .eq("conversation_id", existing_conversation.data[0]["id"])
            .in_("template_name", candidate_templates)
            .limit(1)
            .execute()
        )
        if already_sent.data:
            print("Confirmation already sent for this order. Skipping.")
            return "Duplicate ignored", 200

    if use_bank_template:
        whatsapp_message_id = send_whatsapp_bank_deposit(extracted)
        if whatsapp_message_id:
            log_outgoing_bank_deposit_message(extracted, whatsapp_message_id)
        else:
            print("WhatsApp bank-deposit template failed. Not logged as outgoing message.")
    else:
        whatsapp_message_id = send_whatsapp_confirmation(extracted)
        if whatsapp_message_id:
            log_outgoing_order_message(extracted, whatsapp_message_id)
        else:
            print("WhatsApp confirmation failed. Not logged as outgoing message.")

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

    # DB-level dedup: have we already sent a fulfillment template for this order?
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
            .limit(1)
            .execute()
        )
        if already_sent.data:
            print("Fulfillment notice already sent for this order. Skipping.")
            return "Duplicate ignored", 200

    whatsapp_message_id = send_whatsapp_fulfillment(extracted)

    if whatsapp_message_id:
        log_outgoing_fulfillment_message(extracted, whatsapp_message_id)
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

@app.route("/send-message", methods=["POST", "OPTIONS"])
def send_message():
    """Send a free-form text reply from the inbox.

    Wrapped in defensive error handling so every failure path returns a
    proper JSON response with CORS headers — otherwise an unhandled
    exception (e.g. WhatsApp API timeout, network error) makes
    PythonAnywhere return a header-less 500 and the browser surfaces it
    as a generic 'CORS error' with no diagnostic value."""
    if request.method == "OPTIONS":
        return "", 204

    data = request.get_json(silent=True) or {}
    phone = format_phone(data.get("phone"))
    message = (data.get("message") or "").strip()
    conversation_id = data.get("conversation_id")

    if not phone or not message or not conversation_id:
        return jsonify({
            "success": False,
            "error": "phone, message and conversation_id are required",
        }), 400

    url = f"https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": phone,
        "type": "text",
        "text": {"body": message},
    }
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=20)
    except requests.exceptions.Timeout:
        print("===== SEND MESSAGE TIMEOUT =====")
        return jsonify({
            "success": False,
            "error": "WhatsApp API timed out. Please try again.",
        }), 504
    except requests.exceptions.RequestException as e:
        print(f"===== SEND MESSAGE NETWORK ERROR: {e} =====")
        return jsonify({
            "success": False,
            "error": f"Could not reach WhatsApp API: {type(e).__name__}",
        }), 502

    print("===== SEND MESSAGE RESPONSE =====")
    print(response.status_code)
    print(response.text[:600])

    if response.status_code not in (200, 201):
        # Try to surface Meta's actual error message so the frontend can
        # show something useful instead of a generic 'Failed to send'.
        meta_error = response.text
        try:
            parsed = response.json()
            err = parsed.get("error") or {}
            msg = err.get("message") or ""
            code = err.get("code")
            details = err.get("error_data", {}).get("details") or ""
            meta_error = " | ".join(p for p in [
                f"#{code}" if code is not None else "",
                msg,
                details,
            ] if p) or response.text
        except Exception:
            pass
        return jsonify({"success": False, "error": meta_error}), 400

    try:
        result = response.json()
    except Exception:
        result = {}
    whatsapp_message_id = (result.get("messages") or [{}])[0].get("id")

    try:
        supabase.table("messages").insert({
            "conversation_id": conversation_id,
            "whatsapp_message_id": whatsapp_message_id,
            "direction": "outgoing",
            "type": "text",
            "body": message,
            "status": "sent",
            "raw_payload": result,
        }).execute()

        supabase.table("conversations").update({
            "last_message": message,
            "last_message_at": "now()",
            "unread_count": 0,
            "updated_at": "now()",
        }).eq("id", conversation_id).execute()
    except Exception as e:
        # WhatsApp already accepted the message, so don't fail the request
        # — just log so we can investigate. The status webhook will reconcile.
        print(f"===== SEND MESSAGE DB LOG FAILED: {e} =====")

    return jsonify({
        "success": True,
        "whatsapp_message_id": whatsapp_message_id,
    }), 200


# =========================
# CONVERSATION STATUS (manual overrides from the inbox UI)
# =========================

@app.route("/conversations/<conversation_id>/set-status", methods=["POST", "OPTIONS"])
def set_conversation_status(conversation_id):
    """Let the merchant flip a conversation's tag from the inbox dropdown.

    Body: { "last_template": "paid" | "bank_pending" | null,
            "is_cancelled": true | false }   (each field optional)
    """
    if request.method == "OPTIONS":
        return "", 204
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

    return jsonify({"success": True, "conversation": result.data[0]}), 200


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
