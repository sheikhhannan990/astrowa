# Quick Start Guide - AstroLamps WhatsApp Inbox UI

## 🚀 Get Started in 5 Minutes

### Prerequisites Check

Before starting, make sure you have:
- ✅ Node.js 16+ installed (`node --version`)
- ✅ Flask backend running on `http://127.0.0.1:5000`
- ✅ Supabase project with all tables created
- ✅ Supabase anon key (from Settings → API)

---

## Step 1: Setup Project (1 min)

```bash
# Navigate to frontend folder
cd "c:\Users\hanna\Desktop\shopify flask app\frontend"

# Install dependencies
npm install
```

---

## Step 2: Configure Environment (1 min)

Create `.env` file from the template:

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
VITE_SUPABASE_URL=https://aqdnzkjrbflciecluqyz.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
VITE_API_BASE_URL=http://127.0.0.1:5000
```

**Where to find these:**
- **Supabase URL**: Supabase Dashboard → Settings → API → Project URL
- **Supabase Anon Key**: Supabase Dashboard → Settings → API → Anon public key
- **API Base URL**: Your Flask backend URL (usually `http://127.0.0.1:5000`)

⚠️ **IMPORTANT**: 
- Use the **ANON key** (public), NOT the service role key
- Service role key stays private on backend only

---

## Step 3: Start Development Server (1 min)

```bash
npm run dev
```

You should see:
```
  VITE v5.2.0  ready in 123 ms

  ➜  Local:   http://localhost:5173/
  ➜  press h + enter to show help
```

Open your browser to **http://localhost:5173**

---

## Step 4: Verify Everything Works (2 min)

✅ You should see:
1. **Conversation list** on the left (or full-screen on mobile)
2. **No selection message** on the right if desktop
3. **Search bar** at the top
4. **Loading indicator** while fetching conversations

If you have conversations in Supabase, they should appear immediately!

---

## 🔧 Troubleshooting

### "Cannot find module 'supabase'"

```bash
npm install supabase
```

### "Environment variables not found"

- Make sure `.env` file exists in `frontend/` directory
- Variables must start with `VITE_` to be accessible in frontend
- Restart dev server after changing `.env`

### "No conversations appearing"

1. Check Supabase has conversations in the table:
   ```sql
   SELECT * FROM conversations LIMIT 10;
   ```

2. Verify credentials in `.env` are correct

3. Check browser console (F12) for errors

### "Can't send messages"

1. Check Flask is running: `python app.py`
2. Test Flask endpoint: `curl http://127.0.0.1:5000/`
3. Check Flask console for errors
4. Verify phone number format in Supabase (should have country code, like 923334727820)

### "Real-time not working"

1. Enable Realtime in Supabase:
   - Go to Supabase Dashboard
   - Click on `conversations` table
   - Toggle "Realtime" on
   - Repeat for `messages` table

2. Check browser console for connection errors

---

## 📁 Project Structure

```
frontend/
├── src/
│   ├── components/          # React components
│   ├── utils/              # Supabase & API helpers
│   ├── App.jsx             # Main app
│   ├── main.jsx            # Entry point
│   └── index.css           # Global styles
├── index.html
├── package.json
├── vite.config.js
├── .env                    # Your credentials (create this!)
├── .env.example            # Template
└── README.md               # Full documentation
```

---

## 🎨 UI Overview

### Desktop View
```
┌─────────────────────────────────┐
│ Conversations │ Chat Window     │
│ (List)        │ (Messages)      │
│               │ (Input)         │
└─────────────────────────────────┘
```

### Mobile View
```
┌──────────────────────┐
│ Conversations (list) │  ← Tap to open chat
└──────────────────────┘
                  ↓
┌──────────────────────┐
│ ← Back Chat Window   │
│      (messages)      │
│      (input)         │
└──────────────────────┘
```

---

## ✨ Features

| Feature | Status |
|---------|--------|
| View conversations | ✅ |
| Search conversations | ✅ |
| Real-time message updates | ✅ |
| Send messages | ✅ |
| Message status indicators | ✅ |
| Unread badges | ✅ |
| Mobile responsive | ✅ |
| Template messages | ✅ |
| Customer info display | ✅ |

---

## 📚 Building for Production

When ready to deploy:

```bash
# Build optimized production version
npm run build

# Preview production build locally
npm run preview
```

Output will be in `dist/` folder - ready to deploy!

---

## 🆘 Still Having Issues?

1. **Check Flask Backend**
   ```bash
   # In your backend directory
   python app.py
   ```
   Should show: `Running on http://127.0.0.1:5000`

2. **Verify Supabase Connection**
   - Open browser DevTools (F12)
   - Go to Console tab
   - Any red errors will show issues

3. **Check Environment File**
   - Verify `.env` exists
   - All three variables are filled
   - No extra spaces or quotes

4. **Restart Everything**
   - Stop dev server (Ctrl+C)
   - Close browser tab
   - Run `npm run dev` again
   - Refresh browser

---

## 📞 Environment Values Reference

Make sure these are filled in your `.env`:

```env
# Your Supabase project URL
VITE_SUPABASE_URL=https://YOURPROJECT.supabase.co

# Your Supabase PUBLIC anon key (NOT service role!)
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...

# Your Flask backend URL
VITE_API_BASE_URL=http://127.0.0.1:5000
```

---

## ✅ You're All Set!

Your WhatsApp inbox should now be running at **http://localhost:5173** 🎉

For detailed documentation, see [README.md](./README.md)
