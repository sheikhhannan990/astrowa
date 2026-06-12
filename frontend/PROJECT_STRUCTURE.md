# Complete Project Structure & File Reference

## 📦 Frontend Project Layout

```
frontend/
│
├── 📄 package.json                 # Dependencies & scripts
├── 📄 vite.config.js               # Vite configuration
├── 📄 index.html                   # HTML entry point
│
├── 🔐 .env                         # Environment variables (create from .env.example)
├── 📄 .env.example                 # Environment template
├── 📄 .gitignore                   # Git ignore rules
│
├── 📖 README.md                    # Complete documentation
├── 📖 SETUP.md                     # Quick start guide
│
└── 📁 src/                         # Source code
    │
    ├── 📄 main.jsx                 # React entry point
    ├── 📄 index.css                # Global styles & CSS variables
    │
    ├── 📄 App.jsx                  # Main app component (layouts, routing)
    ├── 📄 App.css                  # App layout styles
    │
    ├── 📁 components/              # React components
    │   ├── 📄 ConversationList.jsx # Sidebar - list of conversations
    │   ├── 📄 ConversationList.css
    │   │
    │   ├── 📄 ChatWindow.jsx       # Main chat interface
    │   ├── 📄 ChatWindow.css
    │   │
    │   ├── 📄 MessageBubbles.jsx   # Message rendering (incoming/outgoing)
    │   ├── 📄 MessageBubbles.css
    │   │
    │   ├── 📄 ReplyInput.jsx       # Message composer with send button
    │   └── 📄 ReplyInput.css
    │
    └── 📁 utils/                   # Utility functions
        ├── 📄 supabaseClient.js    # Supabase client initialization
        └── 📄 api.js               # API calls to Flask backend
```

---

## 📋 File Descriptions

### Configuration Files

#### `package.json`
- **Purpose**: Defines project metadata and dependencies
- **Scripts**:
  - `npm run dev` - Start development server on port 5173
  - `npm run build` - Build for production
  - `npm run preview` - Preview production build
- **Dependencies**:
  - `react` - UI framework
  - `react-dom` - React DOM rendering
  - `supabase` - Supabase client library
  - `axios` - HTTP client for API calls

#### `vite.config.js`
- **Purpose**: Vite bundler configuration
- **Key settings**:
  - Uses `@vitejs/plugin-react` for React fast refresh
  - Dev server port: 5173

#### `index.html`
- **Purpose**: HTML entry point
- **Contains**: Root div for React mounting, script tag for main.jsx

#### `.env` (Create this!)
- **Purpose**: Environment variables
- **Variables**:
  - `VITE_SUPABASE_URL` - Your Supabase project URL
  - `VITE_SUPABASE_ANON_KEY` - Public anon key (NOT service role!)
  - `VITE_API_BASE_URL` - Flask backend URL

#### `.env.example`
- **Purpose**: Template for `.env` - copy and fill with your values

---

### Source Code Files

#### `src/main.jsx`
- **Purpose**: React entry point
- **Function**: Mounts React app to DOM and renders App component

#### `src/index.css`
- **Purpose**: Global styles and CSS variables
- **Contains**:
  - Color definitions (WhatsApp green theme)
  - Typography settings
  - Utility classes (.truncate, .line-clamp-2)
  - Global animations
  - Media queries for responsive design
- **CSS Variables** (customize theme here):
  - `--color-primary: #25d366` (WhatsApp green)
  - `--color-text-primary: #111b21` (Dark text)
  - `--color-incoming: #e7f5eb` (Incoming message color)
  - `--color-outgoing: #d9f5e2` (Outgoing message color)

---

### App Component (`src/App.jsx` + `src/App.css`)

**Purpose**: Main application container

**Responsibilities**:
1. Fetches conversations from Supabase on mount
2. Manages selected conversation state
3. Handles desktop/mobile layout switching (>768px = desktop)
4. Subscribes to conversation table changes (Realtime)
5. Implements search/filter functionality

**Key Functions**:
- `fetchConversations()` - Gets all conversations sorted by last message
- `handleSelectConversation()` - Sets active conversation
- `handleBackFromChat()` - Clears selection on mobile
- `handleConversationUpdate()` - Refreshes list after changes

**Layout**:
- **Desktop**: Sidebar (left) + Main content (right)
- **Mobile**: Full-screen (either list or chat)

---

### Components (`src/components/`)

#### `ConversationList.jsx` + `.css`

**Purpose**: Displays list of all conversations

**Features**:
- Shows customer name, phone, order ID, last message
- Unread count badges
- Formatted timestamps (Today, Yesterday, dates)
- Search functionality
- Click to select conversation
- Highlighted active conversation

**Key Functions**:
- `formatDate()` - Makes timestamps human-readable
- `formatPhone()` - Formats phone to +92 300 0472782 format

**Styling**:
- Responsive layout
- Avatar with customer initial
- Green highlight for active/unread

---

#### `ChatWindow.jsx` + `.css`

**Purpose**: Main chat interface

**Responsibilities**:
1. Loads messages for selected conversation
2. Marks conversation as read (unread_count = 0)
3. Subscribes to new messages in real-time
4. Auto-scrolls to latest message
5. Displays chat header with customer info
6. Contains MessageBubbles and ReplyInput

**Key Functions**:
- `fetchMessages()` - Gets all messages sorted by timestamp
- `markConversationAsRead()` - Updates unread_count to 0
- Realtime subscription to messages table

**Subscriptions**:
- Listens for new/updated messages in conversation
- Updates UI instantly when messages arrive

---

#### `MessageBubbles.jsx` + `.css`

**Purpose**: Renders individual messages

**Features**:
- Left-aligned incoming messages (green background)
- Right-aligned outgoing messages (lighter green)
- Message status indicators:
  - ✓ = Sent
  - ✓✓ = Delivered
  - ✓✓ (blue) = Read
  - ✗ = Failed
- Timestamps on each message
- Support for template messages
- Smooth animations

**Message Types Supported**:
- `text` - Regular text messages
- `template` - Template messages with badge
- `button` - Button messages
- `image` - Image messages

**Status Color Coding**:
- Gray (`--color-message-sent`) for sent
- Green (`--color-message-delivered`) for delivered
- Blue (`--color-message-read`) for read
- Red for failed

---

#### `ReplyInput.jsx` + `.css`

**Purpose**: Message composition and sending

**Features**:
- Auto-expanding textarea
- Send button with loading state
- Enter to send, Shift+Enter for newline
- Error message display
- Disabled state while sending

**Key Functions**:
- `handleSendMessage()` - Calls Flask API to send message
- `handleKeyPress()` - Detects Enter key (Ctrl+C to send, Shift+Enter for newline)

**API Call**:
```javascript
POST /send-message
{
  phone: "923334727820",
  message: "Hello customer",
  conversation_id: "uuid"
}
```

---

### Utilities (`src/utils/`)

#### `supabaseClient.js`

**Purpose**: Initialize Supabase client

**What it does**:
1. Reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `.env`
2. Creates and exports Supabase client instance
3. Throws error if credentials missing

**Export**: `supabase` - Used throughout app for database access

**Usage**:
```javascript
import { supabase } from '../utils/supabaseClient'

// Fetch data
const { data } = await supabase.from('conversations').select('*')

// Subscribe to changes
supabase.channel('channel_name').on('postgres_changes', ...)
```

---

#### `api.js`

**Purpose**: API calls to Flask backend

**Functions**:
- `sendMessage(phone, message, conversationId)` - POST to /send-message

**What it does**:
1. Creates Axios instance with `VITE_API_BASE_URL`
2. Exports `sendMessage()` function
3. Handles errors and throws them for component handling

**Usage**:
```javascript
import { sendMessage } from '../utils/api'

try {
  const response = await sendMessage(phone, message, conversationId)
  console.log('Message sent:', response)
} catch (error) {
  console.error('Failed:', error)
}
```

---

## 🔄 Data Flow Diagram

```
┌─────────────────┐
│  Supabase DB    │
│  Tables:        │
│  - customers    │
│  - conversations│
│  - messages     │
└────────┬────────┘
         │
    ┌────▼─────────────────────────────┐
    │   Supabase Client (supabaseClient.js)
    │   - Fetch data
    │   - Subscribe to changes
    └────┬──────────────────────────────┘
         │
    ┌────▼──────────┐
    │   App.jsx     │ ← Manages state & layout
    │   - Conversations fetch
    │   - Selected conversation
    │   - Search filter
    └────┬───────────┘
         │
         ├─► ConversationList.jsx ◄──┐
         │   (Shows list)             │
         │                            │ Search
         ├─► ChatWindow.jsx           │ input
         │   ├─► MessageBubbles.jsx   │
         │   └─► ReplyInput.jsx ──────┘
         │       (Calls api.js)
         │           │
         └───────────┼──────────────────┐
                     │                  │
          ┌──────────▼──────────┐      │
          │   Flask Backend    │      │
          │ /send-message      │      │
          │ /shopify/order...  │      │
          │ /whatsapp/webhook  │      │
          └────────┬───────────┘      │
                   │                  │
                   └──► Supabase DB ──┘
                       (insert messages)
                           │
                           ▼
                   Realtime subscription
                   (MessageBubbles updates)
```

---

## 🎯 Component Interaction

```
App (Root)
├── Listens to: conversations table (realtime)
├── Manages: selectedConversation, conversations[], searchTerm
│
├── ConversationList (Left sidebar / Mobile list)
│   ├── Props: conversations[], selectedConversation, onSelectConversation
│   ├── Shows: List of conversations with search
│   └── Emits: onSelectConversation event
│
└── ChatWindow (Right panel / Mobile chat)
    ├── Props: conversation, onBack, onConversationUpdate
    ├── Fetches: messages for selected conversation
    ├── Listens to: messages table (realtime)
    ├── Auto-marks: conversation as read
    │
    ├── MessageBubbles
    │   ├── Props: messages[]
    │   ├── Shows: All messages with status
    │   └── Features: Auto-scroll, animations
    │
    └── ReplyInput
        ├── Props: conversation
        ├── Input: Text from user
        ├── Sends: POST to Flask /send-message
        └── Emits: onMessageSent (refresh trigger)
```

---

## 🎨 CSS Architecture

### Color System (index.css)
```css
--color-primary: #25d366              /* Main green */
--color-primary-dark: #1fac5f         /* Darker green */
--color-primary-light: #e7f5eb        /* Light green bg */
--color-text-primary: #111b21         /* Main text */
--color-text-secondary: #65676b       /* Secondary text */
--color-background: #ffffff           /* Page bg */
--color-background-secondary: #f0f2f5 /* Input bg */
--color-border: #e5e5ea               /* Dividers */
--color-incoming: #e7f5eb             /* Incoming msg bg */
--color-outgoing: #d9f5e2             /* Outgoing msg bg */
```

### Responsive Breakpoints
```css
Desktop: 768px and up (side-by-side layout)
Mobile: below 768px (full-screen, one view at a time)
```

---

## 🚀 Running the App

### Development
```bash
npm run dev
# Opens http://localhost:5173
# Hot reload on file changes
```

### Production Build
```bash
npm run build
# Creates optimized dist/ folder
# Ready for deployment

npm run preview
# Test production build locally
```

---

## ✅ Checklist Before Deployment

- [ ] `.env` file created with all three variables
- [ ] Flask backend running on correct port
- [ ] Supabase Realtime enabled for conversations and messages tables
- [ ] Supabase anon key used (not service role)
- [ ] All table names match schema exactly
- [ ] npm run build completes without errors
- [ ] dist/ folder generated
- [ ] `npm run preview` works

---

## 📞 Quick Reference

| Need | File | Function |
|------|------|----------|
| Change colors | `src/index.css` | Update CSS variables |
| Add new component | `src/components/` | Create .jsx + .css |
| Add API endpoint | `src/utils/api.js` | Add new function |
| Change layout | `src/App.jsx` | Modify return JSX |
| Debug database | Browser DevTools | Network tab |
| View real errors | Browser Console | F12 → Console |
| Flask errors | Flask terminal | Check stdout |

---

## 🆘 Common Edits

### Change WhatsApp green color to different color
Edit in `src/index.css`:
```css
--color-primary: #YOUR_COLOR;
```

### Change sidebar width
Edit in `src/index.css`:
```css
--size-sidebar-width: 300px; /* instead of 350px */
```

### Change message bubbles appearance
Edit `src/components/MessageBubbles.css`:
```css
.message-bubble {
  border-radius: 20px; /* rounder corners */
  padding: 12px 16px;  /* more space */
}
```

### Add new message status
1. Add to STATUS_ICONS in `MessageBubbles.jsx`
2. Add CSS style in `MessageBubbles.css`

---

That's your complete project reference! Everything is organized, commented, and ready to customize. 🎉
