# Integration Guide: React Frontend + Flask Backend

This guide explains how the React frontend integrates with your existing Flask backend and how to handle common scenarios.

---

## 🔗 Architecture Overview

```
Your WhatsApp Setup:
┌────────────────┐
│ Shopify Store  │
└────────┬───────┘
         │ (Order created)
         ▼
┌────────────────────────┐
│ Flask Backend (your    │
│ existing app.py)       │
│                        │
│ /shopify/order-created │
│ /whatsapp/webhook      │
│ /send-message          │
│ /                      │
└────────┬───────────────┘
         │
    ┌────┴────────┬─────────────────┐
    │             │                 │
    ▼             ▼                 ▼
┌────────────┐ ┌──────────────┐ ┌──────────────┐
│WhatsApp    │ │Supabase DB   │ │React Frontend│
│Cloud API   │ │(tables)      │ │(this project)│
└────────────┘ └──────────────┘ └──────────────┘
```

---

## 📦 What React Frontend Does

The new React frontend is a **read/write interface** for your Supabase database:

| Operation | React | Flask | Supabase |
|-----------|-------|-------|----------|
| View conversations | ✅ Reads | ❌ | ✅ |
| View messages | ✅ Reads | ❌ | ✅ |
| Send custom message | ✅ Triggers | ✅ Sends | ✅ Logs |
| Receive order message | ❌ | ✅ Receives | ✅ Logs |
| Receive customer reply | ❌ | ✅ Receives | ✅ Logs |
| Mark as read | ✅ Updates | ❌ | ✅ |

---

## 🔌 Flask Backend Integration Points

### 1. The `/send-message` Endpoint (Already exists in your app.py!)

Your Flask backend already has this endpoint that React calls:

```python
@app.route("/send-message", methods=["POST"])
def send_message():
    data = request.json
    phone = format_phone(data.get("phone"))
    message = data.get("message")
    conversation_id = data.get("conversation_id")
    
    # ✅ React will call this endpoint
    # ✅ Flask sends to WhatsApp Cloud API
    # ✅ Flask logs in Supabase
    # ✅ React receives response via Realtime
```

**React calls this with:**
```javascript
POST http://127.0.0.1:5000/send-message
{
  "phone": "923334727820",
  "message": "Thank you for your order!",
  "conversation_id": "abc-123-uuid"
}
```

**Expected response:**
```json
{
  "success": true,
  "whatsapp_message_id": "wamid.HBEUIFkRlZAsXLSBZXJhBhFRlXhN"
}
```

---

### 2. Shopify Order Webhook → Supabase

**Already working**: Your Flask backend receives Shopify orders and logs them:

```python
@app.route("/shopify/order-created", methods=["POST"])
def order_created():
    # ✅ Receives order from Shopify
    # ✅ Sends WhatsApp template
    # ✅ Logs in Supabase (conversations + messages)
    # ✅ React picks up via Realtime
```

React doesn't interact with this - it just displays the results in real-time!

---

### 3. WhatsApp Webhook → Supabase

**Already working**: Meta WhatsApp sends incoming messages to Flask:

```python
@app.route("/whatsapp/webhook", methods=["POST"])
def whatsapp_webhook():
    # ✅ Receives incoming customer message from Meta
    # ✅ Logs in Supabase (messages table)
    # ✅ React picks up via Realtime subscription
```

React doesn't call this - it just subscribes to changes in the messages table!

---

## 🔄 Data Flow Examples

### Example 1: Customer Places Order

```
1. Customer places order on Shopify
   └─ Shopify sends webhook to Flask
   
2. Flask receives: /shopify/order-created
   ├─ Extracts customer info & products
   ├─ Sends WhatsApp template to customer
   ├─ Logs in Supabase:
   │  ├─ Creates/updates customer
   │  ├─ Creates/updates conversation
   │  └─ Logs outgoing template message
   └─ Returns OK
   
3. React Realtime subscription triggers
   ├─ Detects new conversation
   ├─ Detects new message
   ├─ Updates UI instantly
   └─ User sees message in React app
```

### Example 2: Customer Replies to Your Message

```
1. Customer replies "Yes, I confirm my order" on WhatsApp
   └─ Meta webhooks to Flask
   
2. Flask receives: /whatsapp/webhook (incoming message)
   ├─ Extracts message body
   ├─ Logs in Supabase:
   │  ├─ Creates/updates conversation
   │  ├─ Logs incoming message
   │  └─ Increments unread_count
   └─ Returns OK
   
3. React Realtime subscription triggers
   ├─ Detects new message
   ├─ Detects unread_count update
   ├─ Updates UI instantly
   ├─ Message appears in chat
   └─ Badge shows unread count
```

### Example 3: You Reply to Customer from React

```
1. You type "Thank you! Your order ships tomorrow" and press send
   └─ React UI captures message
   
2. React POSTs to Flask: /send-message
   ├─ Body: { phone, message, conversation_id }
   └─ Flask receives
   
3. Flask processes:
   ├─ Calls WhatsApp Cloud API
   ├─ Gets WhatsApp message ID
   ├─ Logs in Supabase (messages table)
   │  ├─ direction: "outgoing"
   │  ├─ body: your message
   │  └─ status: "sent"
   └─ Returns success + WhatsApp message ID
   
4. React receives response
   ├─ Clears input field
   └─ Waits for message to appear (Realtime)
   
5. React Realtime triggers
   ├─ New message row inserted
   ├─ React updates MessageBubbles
   ├─ Message appears with "sent" status
   └─ Auto-scrolls to latest message
   
6. Meta webhook updates message status
   ├─ Message delivered
   ├─ Message read
   └─ Flask updates status in Supabase
   
7. React Realtime triggers again
   ├─ Message status updates
   ├─ ✓ becomes ✓✓ (blue)
   └─ User sees delivery/read status
```

---

## 🔐 Security & Permissions

### Frontend (React) Uses:
- **Supabase Anon Key** (public, safe in frontend)
- Only reads/writes data it should
- Cannot access service role operations

### Backend (Flask) Uses:
- **Supabase Service Role Key** (private, secrets only!)
- Full database access
- Handles sensitive operations

### What React Can Access:
✅ conversations (read/update)
✅ messages (read/insert)
✅ customers (read)

### What React Cannot Access:
❌ message_status_events (read-only, for internal tracking)
❌ Administrative operations

---

## 📞 API Endpoints Reference

### 1. GET `/` (Health Check)
```bash
curl http://127.0.0.1:5000/
# Response: { "status": "running", "app": "AstroLamps WhatsApp..." }
```

### 2. POST `/send-message` (React Calls This)
```bash
curl -X POST http://127.0.0.1:5000/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "923334727820",
    "message": "Your message here",
    "conversation_id": "uuid-here"
  }'

# Response: { "success": true, "whatsapp_message_id": "wamid.xxx" }
```

### 3. POST `/shopify/order-created` (Shopify Calls This)
- React doesn't touch this
- Flask handles automatically
- Data flows to Supabase & WhatsApp

### 4. GET/POST `/whatsapp/webhook` (Meta Calls This)
- React doesn't touch this
- Flask handles automatically
- Data flows to Supabase

---

## 🔗 Connection Checklist

Before running, verify these connections:

### Flask Backend → Supabase
```python
# In your app.py - check these are set:
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
```
✅ Should work - you configured this already!

### Flask Backend → WhatsApp Cloud API
```python
# In your app.py - check these are set:
WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
```
✅ Should work - you configured this already!

### React → Flask Backend
```javascript
// In .env file
VITE_API_BASE_URL=http://127.0.0.1:5000
```
🔧 You need to set this!

### React → Supabase
```javascript
// In .env file
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```
🔧 You need to set this!

---

## 🚀 How to Run Everything

### Terminal 1: Flask Backend
```bash
cd "c:\Users\hanna\Desktop\shopify flask app"
python app.py
# Should see: Running on http://127.0.0.1:5000 (debug mode on)
```

### Terminal 2: React Frontend
```bash
cd "c:\Users\hanna\Desktop\shopify flask app\frontend"
npm run dev
# Should see: Local: http://localhost:5173
```

### Terminal 3 (Optional): ngrok (if needed for webhooks)
```bash
ngrok http 5000
# Share this URL with Shopify/Meta for webhooks
```

---

## 📊 Supabase Realtime Subscriptions

React subscribes to real-time updates:

### What React Listens To:

**1. Conversations Table**
```javascript
// App.jsx listens for:
channel('conversations_channel')
  .on('postgres_changes', 
    { event: '*', schema: 'public', table: 'conversations' },
    // Refreshes list when:
    // - New conversation created
    // - Last message updated
    // - Unread count changes
  )
```

**2. Messages Table (per conversation)**
```javascript
// ChatWindow.jsx listens for:
channel(`messages_${conversation_id}`)
  .on('postgres_changes',
    { 
      event: '*', 
      schema: 'public', 
      table: 'messages',
      filter: `conversation_id=eq.${conversation_id}`
    },
    // New message inserted → appears immediately
    // Message status updated → emoji updates
  )
```

### To Enable Realtime in Supabase:

1. Go to Supabase Dashboard
2. Select your project
3. Click on your database name in sidebar
4. For each table (`conversations`, `messages`):
   - Click the table
   - Click "Realtime" button
   - Toggle "ON"

---

## 🐛 Debugging Common Issues

### Messages not appearing in React

**Check**:
1. Flask backend running? → `python app.py`
2. Supabase credentials in React `.env`?
3. Realtime enabled in Supabase? (Toggle table Realtime on)
4. Table names exactly match schema?

### Can't send messages from React

**Check**:
1. Flask /send-message endpoint working? → `curl http://127.0.0.1:5000/send-message`
2. React `.env` has correct `VITE_API_BASE_URL`
3. Flask console shows request received?
4. WhatsApp token valid in Flask `.env`?

### New conversations not showing

**Check**:
1. Shopify webhook configured to point to Flask?
2. Supabase Realtime enabled for conversations table?
3. Flask logging to conversations table? (Check Flask logs)

### Incoming customer messages not appearing

**Check**:
1. Meta webhook configured to point to Flask?
2. Supabase Realtime enabled for messages table?
3. Flask /whatsapp/webhook triggered? (Check Flask logs)

---

## 🔧 Customization Examples

### Change message send endpoint

**In React** (`src/utils/api.js`):
```javascript
export async function sendMessage(phone, message, conversationId) {
  const response = await apiClient.post('/send-message', { // ← Change this
    phone,
    message,
    conversation_id: conversationId,
  })
  return response.data
}
```

### Add new Flask endpoint

**In Flask** (`app.py`):
```python
@app.route("/api/customer/<id>", methods=["GET"])
def get_customer(id):
    # New endpoint
    return jsonify({"customer": "data"})
```

**In React** (`src/utils/api.js`):
```javascript
export async function getCustomer(id) {
  const response = await apiClient.get(`/api/customer/${id}`)
  return response.data
}
```

**In component**:
```javascript
import { getCustomer } from '../utils/api'

const data = await getCustomer(customerId)
```

---

## 📈 Performance Tips

1. **Limit message query**: Load only last 50 messages initially
2. **Pagination**: Load more on scroll
3. **Message batching**: Don't query every time, batch updates
4. **Realtime filtering**: Use proper table filters to reduce data

---

## 🎯 Next Steps

1. ✅ Create `.env` with your credentials
2. ✅ Verify Flask backend running
3. ✅ Enable Supabase Realtime
4. ✅ Run `npm run dev`
5. ✅ Test by sending a message
6. ✅ Monitor Flask/React console for errors

---

## 📞 Quick Command Reference

```bash
# Check Flask is running
curl http://127.0.0.1:5000/

# Check React app
Open http://localhost:5173 in browser

# Check Supabase connection
npm run dev  # Will error if credentials wrong

# Test sending message
curl -X POST http://127.0.0.1:5000/send-message \
  -H "Content-Type: application/json" \
  -d '{"phone":"923334727820","message":"Hi","conversation_id":"test-uuid"}'

# View React console (debug)
F12 → Console tab

# View Flask logs
Check Flask terminal output

# View Supabase changes
Supabase Dashboard → SQL Editor → SELECT * FROM messages
```

---

That's everything! Your React frontend is now integrated with your existing Flask backend. They work together seamlessly! 🎉
