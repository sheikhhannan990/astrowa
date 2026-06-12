# AstroLamps WhatsApp Inbox UI

A modern WhatsApp-style inbox UI built with React and Vite for managing customer conversations integrated with Shopify, WhatsApp Cloud API, and Supabase.

## Features

- ✅ Real-time conversation list with search
- ✅ WhatsApp-style chat interface
- ✅ Message status indicators (sent, delivered, read, failed)
- ✅ Template message support
- ✅ Supabase Realtime for live updates
- ✅ Mobile responsive design
- ✅ Auto-scroll to latest messages
- ✅ Unread message badges
- ✅ Customer information display (name, phone, order ID)
- ✅ Send custom replies
- ✅ Clean, modern UI

## Project Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── ConversationList.jsx       # List of conversations
│   │   ├── ConversationList.css
│   │   ├── ChatWindow.jsx             # Main chat interface
│   │   ├── ChatWindow.css
│   │   ├── MessageBubbles.jsx         # Message display
│   │   ├── MessageBubbles.css
│   │   ├── ReplyInput.jsx             # Message input
│   │   └── ReplyInput.css
│   ├── utils/
│   │   ├── supabaseClient.js          # Supabase initialization
│   │   └── api.js                     # API calls to Flask backend
│   ├── App.jsx                        # Main app component
│   ├── App.css
│   ├── main.jsx                       # Entry point
│   └── index.css                      # Global styles
├── .env.example                       # Environment template
├── .gitignore
├── vite.config.js
├── package.json
└── index.html
```

## Prerequisites

- Node.js 16+ and npm
- Supabase project with tables already created
- Flask backend running on `http://127.0.0.1:5000`
- Supabase anon key (NOT service role key - that should stay private on backend)

## Installation & Setup

### Step 1: Install Dependencies

```bash
cd frontend
npm install
```

### Step 2: Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
VITE_API_BASE_URL=http://127.0.0.1:5000
```

**Important:** 
- Use your Supabase **anon key** (public key), NOT the service role key
- The service role key should ONLY be used in your Flask backend
- Get these values from Supabase dashboard → Settings → API

### Step 3: Start Development Server

```bash
npm run dev
```

The app will open at `http://localhost:5173`

## How It Works

### Frontend Architecture

1. **App.jsx** - Main container
   - Manages conversations list
   - Handles desktop/mobile layout switching
   - Subscribes to conversation updates
   - Provides search functionality

2. **ConversationList.jsx** - Sidebar component
   - Displays all conversations
   - Shows unread badges
   - Formats timestamps
   - Search/filter functionality

3. **ChatWindow.jsx** - Main chat interface
   - Loads messages for selected conversation
   - Marks conversation as read
   - Subscribes to real-time message updates
   - Auto-scrolls to latest message

4. **MessageBubbles.jsx** - Message rendering
   - Shows incoming (left) and outgoing (right) messages
   - Displays message status indicators
   - Supports template messages
   - Shows timestamps

5. **ReplyInput.jsx** - Message composer
   - Text input with auto-resize
   - Enter to send (Shift+Enter for newline)
   - Error handling
   - Loading state during send

### Data Flow

```
Supabase Tables
    ↓
Fetch conversations (sorted by last_message_at)
    ↓
User selects conversation
    ↓
Load messages for conversation
    ↓
Realtime subscriptions for messages & conversation updates
    ↓
User types and sends message
    ↓
POST to Flask /send-message endpoint
    ↓
Flask logs message in Supabase
    ↓
Frontend receives via realtime subscription
```

## API Integration

### Sending Messages

The frontend calls `POST /send-message` on your Flask backend:

```javascript
// src/utils/api.js
sendMessage(phone, message, conversationId)
```

**Request body:**
```json
{
  "phone": "923334727820",
  "message": "Thank you for confirming your order.",
  "conversation_id": "conversation_uuid_here"
}
```

**Expected response:**
```json
{
  "success": true,
  "whatsapp_message_id": "wamid.xxx"
}
```

## Supabase Schema Requirements

Make sure your Supabase tables match exactly:

### customers
- `id` (uuid, pk)
- `name` (text)
- `phone` (text)
- `created_at` (timestamptz)

### conversations
- `id` (uuid, pk)
- `customer_id` (uuid, fk)
- `phone` (text)
- `customer_name` (text)
- `order_id` (text)
- `status` (text)
- `last_message` (text)
- `last_message_at` (timestamptz)
- `last_customer_message_at` (timestamptz)
- `unread_count` (int)
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

### messages
- `id` (uuid, pk)
- `conversation_id` (uuid, fk)
- `whatsapp_message_id` (text)
- `direction` (text) - "incoming" or "outgoing"
- `type` (text) - "text", "template", "button", "image"
- `body` (text)
- `template_name` (text)
- `status` (text) - "sent", "delivered", "read", "failed", "received"
- `raw_payload` (jsonb)
- `created_at` (timestamptz)

### message_status_events
- `id` (uuid, pk)
- `message_id` (uuid, fk)
- `whatsapp_message_id` (text)
- `status` (text)
- `raw_payload` (jsonb)
- `created_at` (timestamptz)

## Features Explained

### Real-time Updates

The app uses Supabase Realtime to automatically update:

1. **New messages** - Appear instantly when received
2. **Message status** - Updates when WhatsApp delivers/reads
3. **Conversation list** - Updates when new messages arrive
4. **Unread badges** - Update in real-time

### Mobile Responsive

- **Desktop (>768px):** Side-by-side layout (conversations on left, chat on right)
- **Mobile (<768px):** Full-screen views with back button to switch between list and chat

### Message Status Indicators

- **✓** - Sent
- **✓✓** - Delivered (WhatsApp received)
- **✓✓** (blue) - Read
- **✗** - Failed to send
- **⟳** - Currently sending

### Search Functionality

Search by:
- Customer name
- Phone number
- Order ID

## Styling

Uses CSS variables for easy theming. All styles in `src/index.css`:

```css
--color-primary: #25d366          /* WhatsApp green */
--color-text-primary: #111b21     /* Dark text */
--color-incoming: #e7f5eb         /* Light green for incoming */
--color-outgoing: #d9f5e2         /* Green tint for outgoing */
```

## Troubleshooting

### Messages not loading

1. Check if Supabase credentials are correct
2. Verify table names match exactly (case-sensitive)
3. Check browser console for errors
4. Ensure anon key has read permissions on tables

### Real-time not working

1. Verify Supabase Realtime is enabled (Settings → Realtime)
2. Check that table name and filter are correct
3. Ensure anon key has realtime permissions

### Can't send messages

1. Check Flask backend is running on correct port
2. Verify VITE_API_BASE_URL is correct
3. Check Flask console for errors
4. Verify phone number format (should be with country code)

### CORS errors

If getting CORS errors from Flask:

```python
# Add to Flask app
from flask_cors import CORS
CORS(app)
```

## Build for Production

```bash
npm run build
```

This creates optimized production build in `dist/` folder.

To preview production build:

```bash
npm run preview
```

## Environment Checklist

Before deploying:

- [ ] Supabase URL is correct
- [ ] Supabase anon key is used (not service role)
- [ ] Flask backend URL is correct
- [ ] Flask backend is running
- [ ] Supabase Realtime is enabled
- [ ] Database tables exist with correct schema
- [ ] Table permissions allow anon reads

## Support

For issues:
1. Check browser console (F12)
2. Check Flask console for backend errors
3. Verify Supabase credentials
4. Check network tab in DevTools
5. Check Supabase Realtime status

## License

MIT
