from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
from datetime import datetime, timedelta, timezone
import os
import json
import threading
import time
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
REMINDER_TEMPLATE_NAME = os.getenv("WHATSAPP_REMINDER_TEMPLATE_NAME")
TEMPLATE_LANGUAGE = os.getenv("WHATSAPP_TEMPLATE_LANGUAGE", "en")
WHATSAPP_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN")

FRONTEND_URL = os.getenv("FRONTEND_URL", "").strip()
REMINDER_HOURS = int(os.getenv("REMINDER_HOURS", "20"))
# Look back this many additional hours so a 30-min cron tick never misses a
# confirmation that aged into the window between sweeps.
REMINDER_WINDOW_HOURS = int(os.getenv("REMINDER_WINDOW_HOURS", "3"))
# Secret shared with the external cron service (cron-job.org / GitHub Actions /
# Upstash QStash). Required to call /internal/run-reminders.
REMINDER_CRON_SECRET = os.getenv("REMINDER_CRON_SECRET", "").strip()

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# CORS: lock down origins so prod (Netlify) and dev (Vite) both work, but
# nothing else can hit the API from a browser.
_allowed_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
if FRONTEND_URL:
    _allowed_origins.append(FRONTEND_URL)
CORS(app, origins=_allowed_origins)


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
    phone = str(phone or "").replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    if phone.startswith("+"):
        phone = phone[1:]
    if phone.startswith("0"):
        phone = "92" + phone[1:]
    return phone


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
        products.append(f"{item.get('title')} x {item.get('quantity')}")

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

    return {
        "customer_name": _customer_name_from(order),
        "customer_phone": get_customer_phone(order),
        "order_number": order.get("name") or str(order.get("order_number")),
        "tracking_company": tracking_company,
        "tracking_number": tracking_number,
    }


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


def send_whatsapp_confirmation(data):
    return _send_template(
        TEMPLATE_NAME,
        data["customer_phone"],
        [
            data["customer_name"],
            data["order_number"],
            data["products_text"],
            str(data["total_price"]),
        ],
    )


def send_whatsapp_fulfillment(data):
    return _send_template(
        FULFILLMENT_TEMPLATE_NAME,
        data["customer_phone"],
        [
            data["customer_name"],
            data["order_number"],
            data["tracking_company"],
            data["tracking_number"],
        ],
    )


def send_whatsapp_reminder(data):
    return _send_template(
        REMINDER_TEMPLATE_NAME,
        data["customer_phone"],
        [
            data["customer_name"],
            data["order_number"],
            str(data["total_price"]),
        ],
    )


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
        f"Hi {data['customer_name']} 👋\n\n"
        f"Thank you for shopping with AstroLamps ✨\n\n"
        f"We've received your order and it's being prepared for dispatch.\n\n"
        f"📦 Order Summary\n"
        f"Order ID: {data['order_number']}\n"
        f"Items: {data['products_text']}\n"
        f"Total Amount: Rs. {data['total_price']}\n\n"
        f"🚚 Estimated delivery: 2-4 working days\n\n"
        f"Please confirm your order below so we can dispatch it on time."
    )

    preview_body = (
        f"Order {data['order_number']} | "
        f"{data['products_text']} | "
        f"Rs. {data['total_price']}"
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
        "updated_at": "now()",
    }).eq("id", conversation["id"]).execute()

    print(f"Outgoing confirmation logged in Supabase.")
    return conversation["id"]


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
        f"Hi {data['customer_name']} 📦\n\n"
        f"Great news — your AstroLamps order is on its way!\n\n"
        f"✨ Shipment Details\n"
        f"Order ID: {data['order_number']}\n"
        f"Courier: {data['tracking_company']}\n"
        f"Tracking #: {data['tracking_number']}\n\n"
        f"🚚 Expected delivery: 2-3 working days\n\n"
        f"Sit tight — your AstroLamp will brighten your space very soon 💡\n\n"
        f"Thank you for choosing AstroLamps."
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

    supabase.table("conversations").update({
        "last_message": preview_body,
        "last_message_at": "now()",
        "updated_at": "now()",
    }).eq("id", conversation["id"]).execute()

    print(f"Outgoing fulfillment logged in Supabase.")
    return conversation["id"]


def log_outgoing_reminder_message(data, whatsapp_message_id, conversation_id):
    message_body = (
        f"Hi {data['customer_name']}, just checking in 👋\n\n"
        f"We haven't received your confirmation for your AstroLamps order yet.\n\n"
        f"📦 Order: {data['order_number']}\n"
        f"💰 Total: Rs. {data['total_price']}\n\n"
        f"Please confirm below so we can dispatch your order today. "
        f"If we don't hear back, your order may be placed on hold."
    )

    preview_body = f"⏰ Reminder sent for order {data['order_number']}"

    supabase.table("messages").insert({
        "conversation_id": conversation_id,
        "whatsapp_message_id": whatsapp_message_id,
        "direction": "outgoing",
        "type": "template",
        "body": message_body,
        "template_name": REMINDER_TEMPLATE_NAME,
        "status": "sent",
        "raw_payload": data,
    }).execute()

    supabase.table("conversations").update({
        "last_message": preview_body,
        "last_message_at": "now()",
        "updated_at": "now()",
    }).eq("id", conversation_id).execute()

    print(f"Reminder logged in Supabase for conversation {conversation_id}.")


def log_incoming_message(payload, message):
    phone = format_phone(message.get("from"))
    message_type = message.get("type")
    whatsapp_message_id = message.get("id")

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
        "status": "received",
        "raw_payload": payload,
    }).execute()

    unread_count = conversation.get("unread_count") or 0

    supabase.table("conversations").update({
        "last_message": body,
        "last_message_at": "now()",
        "last_customer_message_at": "now()",
        "unread_count": unread_count + 1,
        "updated_at": "now()",
    }).eq("id", conversation["id"]).execute()

    print(f"Incoming message logged in Supabase.")


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
            .select("id, status")
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

    print("\n===== NEW SHOPIFY ORDER =====")
    print(json.dumps(extracted, indent=2, ensure_ascii=False))
    print(f"X-Shopify-Webhook-Id: {webhook_id}")

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
        # Conversation exists, but only block the confirmation send if we
        # actually already sent a confirmation template for this order.
        already_sent = (
            supabase.table("messages")
            .select("id")
            .eq("conversation_id", existing_conversation.data[0]["id"])
            .eq("template_name", TEMPLATE_NAME)
            .limit(1)
            .execute()
        )
        if already_sent.data:
            print("Confirmation already sent for this order. Skipping.")
            return "Duplicate ignored", 200

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

@app.route("/send-message", methods=["POST"])
def send_message():
    data = request.json
    phone = format_phone(data.get("phone"))
    message = data.get("message")
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

    response = requests.post(url, headers=headers, json=payload)
    print("===== SEND MESSAGE RESPONSE =====")
    print(response.status_code)
    print(response.text)

    if response.status_code in [200, 201]:
        result = response.json()
        whatsapp_message_id = result.get("messages", [{}])[0].get("id")

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

        return jsonify({
            "success": True,
            "whatsapp_message_id": whatsapp_message_id,
        }), 200

    return jsonify({"success": False, "error": response.text}), 400


# =========================
# 20-HOUR REMINDER SCHEDULER
# =========================

def check_and_send_reminders():
    """For confirmations sent REMINDER_HOURS-23h ago where the customer never replied
    and no reminder has been sent yet, fire the order_reminder template.

    Returns a small summary dict so the /internal/run-reminders endpoint can
    surface it in the cron job's response body (useful for cron-job.org logs).
    """
    summary = {"candidates": 0, "sent": 0, "skipped": 0, "errors": 0}

    if not (TEMPLATE_NAME and REMINDER_TEMPLATE_NAME):
        print("[Reminder] Template names not configured — skipping sweep.")
        return summary

    now = datetime.now(timezone.utc)
    upper_bound = (now - timedelta(hours=REMINDER_HOURS)).isoformat()
    lower_bound = (now - timedelta(hours=REMINDER_HOURS + REMINDER_WINDOW_HOURS)).isoformat()

    print(
        f"\n[Reminder] Sweep at {now.isoformat()} "
        f"(confirmations between {lower_bound} and {upper_bound})"
    )

    try:
        confirmations = (
            supabase.table("messages")
            .select("id, conversation_id, created_at, raw_payload")
            .eq("direction", "outgoing")
            .eq("type", "template")
            .eq("template_name", TEMPLATE_NAME)
            .gte("created_at", lower_bound)
            .lte("created_at", upper_bound)
            .execute()
        )
    except Exception as e:
        print(f"[Reminder] Failed to query confirmations: {e}")
        summary["errors"] += 1
        return summary

    candidates = confirmations.data or []
    summary["candidates"] = len(candidates)

    for msg in candidates:
        conv_id = msg["conversation_id"]
        confirmation_sent_at = msg["created_at"]

        try:
            conv_res = (
                supabase.table("conversations")
                .select("*")
                .eq("id", conv_id)
                .limit(1)
                .execute()
            )
            if not conv_res.data:
                continue
            conv = conv_res.data[0]

            last_customer = conv.get("last_customer_message_at")
            if last_customer and last_customer > confirmation_sent_at:
                summary["skipped"] += 1
                continue

            existing_reminder = (
                supabase.table("messages")
                .select("id")
                .eq("conversation_id", conv_id)
                .eq("template_name", REMINDER_TEMPLATE_NAME)
                .limit(1)
                .execute()
            )
            if existing_reminder.data:
                summary["skipped"] += 1
                continue

            raw = msg.get("raw_payload") or {}
            reminder_data = {
                "customer_name": conv.get("customer_name") or raw.get("customer_name") or "Customer",
                "customer_phone": conv.get("phone"),
                "order_number": conv.get("order_id") or raw.get("order_number"),
                "total_price": raw.get("total_price") or "—",
            }

            wid = send_whatsapp_reminder(reminder_data)
            if wid:
                log_outgoing_reminder_message(reminder_data, wid, conv_id)
                summary["sent"] += 1
                print(
                    f"[Reminder] Sent for conversation {conv_id} "
                    f"(order {reminder_data['order_number']})"
                )
            else:
                summary["errors"] += 1
                print(f"[Reminder] Failed to send for conversation {conv_id}")
        except Exception as e:
            summary["errors"] += 1
            print(f"[Reminder] Error processing conversation {conv_id}: {e}")

    print(
        f"[Reminder] Done. Candidates: {summary['candidates']}, "
        f"Sent: {summary['sent']}, Skipped: {summary['skipped']}, Errors: {summary['errors']}"
    )
    return summary


@app.route("/internal/run-reminders", methods=["GET", "POST"])
def run_reminders_endpoint():
    """Triggered by an external cron service (cron-job.org etc.) every ~30 min.

    Protected by REMINDER_CRON_SECRET, which the caller must supply via any of:
      - Header: X-Cron-Secret: <secret>
      - Header: Authorization: Bearer <secret>
      - Query string: ?token=<secret>
    """
    if not REMINDER_CRON_SECRET:
        return jsonify({
            "error": "Endpoint disabled — set REMINDER_CRON_SECRET in env",
        }), 503

    provided = (
        request.headers.get("X-Cron-Secret")
        or (request.headers.get("Authorization") or "").replace("Bearer ", "").strip()
        or request.args.get("token", "")
    )

    if provided != REMINDER_CRON_SECRET:
        return jsonify({"error": "Forbidden"}), 403

    result = check_and_send_reminders()
    return jsonify({"status": "ok", **(result or {})}), 200


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
            "order_dispatched": FULFILLMENT_TEMPLATE_NAME,
            "order_reminder": REMINDER_TEMPLATE_NAME,
        },
        "reminder_window_hours": [REMINDER_HOURS, REMINDER_HOURS + REMINDER_WINDOW_HOURS],
    }), 200


if __name__ == "__main__":
    app.run(port=5000, debug=True)
