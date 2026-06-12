# 🚀 AstroLamps WhatsApp Inbox UI - Complete Setup

Welcome! Your complete React + Vite WhatsApp Inbox UI is ready. This folder contains everything you need to manage your WhatsApp conversations with customers.

---

## 📖 Documentation Files

Start with these in order:

### 1. **[SETUP.md](./SETUP.md)** ⭐ START HERE
**Quick 5-minute setup guide**
- System requirements
- Installation steps  
- Environment configuration
- Troubleshooting basics

### 2. **[README.md](./README.md)**
**Comprehensive documentation**
- Feature overview
- Project structure
- How everything works
- API integration details
- Styling guide
- FAQ & troubleshooting

### 3. **[PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md)**
**Technical reference**
- Complete file-by-file breakdown
- Component responsibilities
- CSS architecture
- Data flow diagrams
- Quick reference tables

### 4. **[INTEGRATION.md](./INTEGRATION.md)**
**How React integrates with Flask backend**
- Architecture overview
- Data flow examples
- Security & permissions
- Common scenarios
- Debugging guide

---

## ⚡ Quick Start (2 min)

```bash
# 1. Install dependencies
npm install

# 2. Create environment file
cp .env.example .env

# 3. Fill in your credentials in .env
# - Supabase URL
# - Supabase Anon Key (NOT service role!)
# - Flask backend URL

# 4. Start development server
npm run dev

# Open http://localhost:5173 in browser ✅
```

---

## 📁 What's Inside

```
frontend/
├── 📖 README.md                 # Full documentation
├── 📖 SETUP.md                  # Quick start guide
├── 📖 PROJECT_STRUCTURE.md      # Technical reference
├── 📖 INTEGRATION.md            # Backend integration
├── 📖 INDEX.md                  # This file
│
├── src/                         # Source code
│   ├── components/              # React components
│   ├── utils/                   # API & Supabase helpers
│   ├── App.jsx                  # Main app
│   └── index.css                # Global styles
│
├── package.json                 # Dependencies
├── vite.config.js               # Vite config
├── index.html                   # HTML entry
│
├── .env.example                 # Template (copy to .env)
└── .gitignore                   # Git ignore
```

---

## ✨ Features

| Feature | Status |
|---------|--------|
| View all conversations | ✅ |
| Search conversations | ✅ |
| Send custom messages | ✅ |
| Real-time message updates | ✅ |
| Message status tracking | ✅ |
| Unread badges | ✅ |
| Mobile responsive | ✅ |
| Customer info display | ✅ |
| Template message support | ✅ |
| Conversation management | ✅ |

---

## 🔐 Requirements

Before starting, you need:

- ✅ **Node.js 16+** - Download from [nodejs.org](https://nodejs.org)
- ✅ **Flask backend running** - Your existing `app.py` on port 5000
- ✅ **Supabase project** - With tables created (schema provided in docs)
- ✅ **Supabase credentials** - URL and anon key (Settings → API)
- ✅ **Browser** - Chrome, Firefox, Safari, or Edge

---

## 🎯 First Time Setup

### Step 1: Configure Environment (1 min)

Create `.env` file by copying `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` and add your values:

```env
# Get from Supabase Dashboard → Settings → API
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...

# Your Flask backend URL
VITE_API_BASE_URL=http://127.0.0.1:5000
```

### Step 2: Install & Run (1 min)

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser!

---

## 🎨 What You'll See

### Desktop View
```
┌─────────────────────────────────────┐
│ Conversations │ Chat Window         │
│   (list)      │ (messages)          │
│   (search)    │ (reply input)       │
└─────────────────────────────────────┘
```

### Mobile View
```
Tap a conversation → Full-screen chat
← Tap back → Return to list
```

---

## 🔗 Integration with Flask Backend

Your React frontend connects to your existing Flask backend:

```
React Frontend
    ↓
POST /send-message
    ↓
Flask Backend
    ↓
Supabase + WhatsApp API
```

All your existing Flask routes (`/shopify/order-created`, `/whatsapp/webhook`) work automatically with the React UI!

---

## 🛠️ Commands

```bash
# Development
npm run dev          # Start dev server on port 5173

# Production
npm run build        # Build optimized version
npm run preview      # Preview production build

# Testing
npm run dev -- --port 5174  # Run on different port
```

---

## 📊 Architecture

```
┌──────────────────────────────────────────┐
│         React Frontend                   │
│  ┌──────────────────────────────────┐   │
│  │ ConversationList │ ChatWindow    │   │
│  │ (sidebar)        │ (messages)    │   │
│  └──────────────────────────────────┘   │
└──────────────┬───────────────────────────┘
               │
    ┌──────────┴──────────┐
    ↓                     ↓
┌─────────────────┐  ┌──────────────┐
│ Flask Backend   │  │ Supabase DB  │
│ (app.py)        │  │ (tables)     │
└─────────────────┘  └──────────────┘
    │       │              ↑
    ↓       └──────────────┘
┌──────────────────────────┐
│ WhatsApp Cloud API       │
│ Meta Webhooks            │
└──────────────────────────┘
```

---

## 🆘 Troubleshooting

### Issue: "Cannot find module 'supabase'"
```bash
npm install supabase
```

### Issue: Port 5173 already in use
```bash
npm run dev -- --port 5174
```

### Issue: Supabase connection failing
- Check `.env` file exists and has correct URL/key
- Verify anon key (not service role key)
- Restart dev server after changing `.env`

### Issue: No conversations showing
- Check Supabase has data: Dashboard → conversations table
- Enable Realtime: Click table → Toggle "Realtime"
- Check browser console (F12) for errors

### Issue: Can't send messages
- Verify Flask running: `python app.py`
- Check VITE_API_BASE_URL in `.env`
- Look for errors in Flask terminal

---

## 📚 Learning Resources

**For React Development:**
- [React Documentation](https://react.dev)
- [Vite Documentation](https://vitejs.dev)

**For Supabase:**
- [Supabase Documentation](https://supabase.com/docs)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript)

**For your Flask Backend:**
- See [INTEGRATION.md](./INTEGRATION.md) for how React integrates with Flask

---

## 📋 Checklist

- [ ] Node.js 16+ installed
- [ ] `.env` file created with credentials
- [ ] Flask backend running (`python app.py`)
- [ ] Supabase Realtime enabled
- [ ] `npm install` completed
- [ ] `npm run dev` started
- [ ] Browser opens to http://localhost:5173
- [ ] Can see conversations list
- [ ] Can send a message

---

## 🎯 Next Steps

1. **Read [SETUP.md](./SETUP.md)** - Complete setup instructions
2. **Run the app** - `npm run dev`
3. **Test features** - View conversations, send messages
4. **Customize** - Change colors in `src/index.css`
5. **Deploy** - `npm run build` when ready

---

## 📞 File Reference

| Task | File |
|------|------|
| Get started quickly | [SETUP.md](./SETUP.md) |
| Full documentation | [README.md](./README.md) |
| File-by-file guide | [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) |
| Backend integration | [INTEGRATION.md](./INTEGRATION.md) |
| Change colors/theme | `src/index.css` |
| Modify components | `src/components/` |
| Add API calls | `src/utils/api.js` |

---

## ✅ You're Ready!

Your WhatsApp Inbox UI is complete and ready to use!

→ **Next: Read [SETUP.md](./SETUP.md) for step-by-step installation**

---

## 🎉 Summary

- ✅ Complete React + Vite project
- ✅ Supabase integration ready
- ✅ Flask backend compatible
- ✅ Mobile responsive design
- ✅ Real-time message updates
- ✅ Production-ready code

Everything is set up and documented. Enjoy! 🚀
