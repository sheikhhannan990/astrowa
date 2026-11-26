import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './utils/supabaseClient'
import { getCurrentStaffId, setCurrentStaffId } from './utils/currentStaff'
import useWorkspaceData from './utils/useWorkspaceData'
import Inbox from './views/Inbox'
import Today from './views/Today'
import Activity from './views/Activity'
import Team from './views/Team'
import './App.css'

const NAV = [
  { id: 'today', label: 'Today', icon: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11zM7 11h5v5H7z' },
  { id: 'inbox', label: 'Inbox', icon: 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z' },
  { id: 'activity', label: 'Activity', admin: true, icon: 'M3 13h2v8H3zm4-6h2v14H7zm4 3h2v11h-2zm4-7h2v18h-2zm4 9h2v9h-2z' },
  { id: 'team', label: 'Team', admin: true, icon: 'M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z' },
]

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
      <path d={d} />
    </svg>
  )
}

export default function App() {
  const [team, setTeam] = useState(undefined) // undefined = loading
  const [loadError, setLoadError] = useState(null)
  const [staffId, setStaffId] = useState(getCurrentStaffId())

  useEffect(() => {
    supabase
      .from('staff')
      .select('*')
      .order('created_at')
      .then(({ data, error }) => {
        if (error) setLoadError(error.message)
        setTeam(data || [])
      })
  }, [staffId])

  const choose = (id) => {
    setCurrentStaffId(id)
    setStaffId(id)
  }

  if (team === undefined) return <div className="app-splash">Loading…</div>
  const staff = team.find((m) => m.user_id === staffId && m.active)
  if (!staff) return <WhoAreYou team={team.filter((m) => m.active)} onChoose={choose} error={loadError} />
  return <Workspace key={staff.user_id} staff={staff} onSwitchUser={() => choose(null)} />
}

// One-time "who's using this device" — remembered in this browser so it's
// never asked again. Not a password, just so actions are recorded under
// the right name.
function WhoAreYou({ team, onChoose, error }) {
  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-logo" aria-hidden>💡</span>
          <div>
            <h1>Who's using this inbox?</h1>
            <p>Pick your name once — this device will remember it.</p>
          </div>
        </div>
        {error && (
          <div className="login-error">
            Couldn't load the team list ({error}). Has the phase 1 SQL been run in Supabase?
          </div>
        )}
        <div className="who-list">
          {team.map((m) => (
            <button key={m.user_id} type="button" className="who-btn" onClick={() => onChoose(m.user_id)}>
              <span className="who-initial">{(m.name || '?')[0].toUpperCase()}</span>
              <span className="who-name">{m.name}</span>
              <span className="td-small">{m.role === 'admin' ? 'Admin' : 'Agent'}</span>
            </button>
          ))}
        </div>
        {!error && team.length === 0 && <p className="login-help">No team members yet — run the phase 1 SQL in Supabase.</p>}
        <p className="login-help">New team member? Ask the admin to add your name on the Team page.</p>
      </div>
    </div>
  )
}

function Workspace({ staff, onSwitchUser }) {
  const data = useWorkspaceData()
  const [view, setView] = useState('today')
  const [selectedConversationId, setSelectedConversationId] = useState(null)
  const [focusOrderId, setFocusOrderId] = useState(null)
  const [isMobileView, setIsMobileView] = useState(typeof window !== 'undefined' && window.innerWidth < 900)
  const isAdmin = staff.role === 'admin'

  useEffect(() => {
    const onResize = () => setIsMobileView(window.innerWidth < 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const openChat = useCallback((conversationId, orderId = null) => {
    if (!conversationId) return
    setSelectedConversationId(conversationId)
    setFocusOrderId(orderId)
    setView('inbox')
  }, [])

  useReminderAlerts(data.followups, data.conversations, openChat)

  const overdue = data.followups.filter((f) => Date.parse(f.due_at) < Date.now()).length
  const waiting = data.conversations.filter((c) => c.needs_reply && !c.is_cancelled).length
  const badges = { today: overdue + waiting, inbox: data.conversations.filter((c) => (c.unread_count || 0) > 0).length }
  const navItems = NAV.filter((n) => !n.admin || isAdmin)

  let content
  if (view === 'today') content = <Today data={data} staff={staff} onOpen={openChat} />
  else if (view === 'activity' && isAdmin) content = <Activity data={data} onOpen={openChat} />
  else if (view === 'team' && isAdmin) content = <Team staff={staff} />
  else {
    content = (
      <Inbox
        data={data}
        staff={staff}
        selectedConversationId={selectedConversationId}
        onSelectConversation={(id) => { setSelectedConversationId(id); setFocusOrderId(null) }}
        focusOrderId={focusOrderId}
        isMobileView={isMobileView}
      />
    )
  }

  // On phones the chat takes the full screen; hide the tab bar there.
  const hideTabs = isMobileView && view === 'inbox' && selectedConversationId

  return (
    <div className="app">
      <div className={isMobileView ? 'ws ws-mobile' : 'ws desktop-view'}>
        {!isMobileView && (
          <nav className="ws-rail" aria-label="Main">
            {navItems.map((n) => (
              <button key={n.id} type="button" className={`ws-nav ${view === n.id ? 'is-active' : ''}`} onClick={() => setView(n.id)} title={n.label}>
                <Icon d={n.icon} />
                <span>{n.label}</span>
                {badges[n.id] > 0 && <span className="ws-badge">{badges[n.id]}</span>}
              </button>
            ))}
            <span className="ws-rail-spacer" />
            <div className="ws-user" title={`${staff.name} (${staff.role})`}>{(staff.name || '?')[0].toUpperCase()}</div>
            <button type="button" className="ws-nav ws-signout" onClick={onSwitchUser} title={`Using as ${staff.name} — switch user`}>
              <Icon d="M10 17v-3H3v-4h7V7l5 5-5 5zm9-14H12v2h7v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
              <span>Switch</span>
            </button>
          </nav>
        )}
        <div className="ws-content">{content}</div>
        {isMobileView && !hideTabs && (
          <nav className="ws-tabs" aria-label="Main">
            {navItems.map((n) => (
              <button key={n.id} type="button" className={`ws-tab ${view === n.id ? 'is-active' : ''}`} onClick={() => setView(n.id)}>
                <Icon d={n.icon} />
                <span>{n.label}</span>
                {badges[n.id] > 0 && <span className="ws-badge">{badges[n.id]}</span>}
              </button>
            ))}
            <button type="button" className="ws-tab" onClick={onSwitchUser}>
              <Icon d="M10 17v-3H3v-4h7V7l5 5-5 5zm9-14H12v2h7v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
              <span>{staff.name}</span>
            </button>
          </nav>
        )}
      </div>
    </div>
  )
}

// Pops a browser notification (and updates the tab title) when a reminder
// falls due while the inbox is open. Internal only — nothing is sent to
// customers.
function useReminderAlerts(followups, conversations, openChat) {
  const notified = useRef(new Set())
  useEffect(() => {
    const check = () => {
      const now = Date.now()
      const due = followups.filter((f) => Date.parse(f.due_at) <= now)
      document.title = due.length ? `(${due.length}) AstroLamps Inbox` : 'AstroLamps Inbox'
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      for (const f of due) {
        if (notified.current.has(f.id)) continue
        notified.current.add(f.id)
        if (now - Date.parse(f.due_at) > 10 * 60000) continue // don't spam old ones on page load
        const c = conversations.find((x) => x.id === f.conversation_id)
        const n = new Notification(`Reminder: ${c?.customer_name || 'customer'}`, {
          body: f.note || (f.kind === 'call' ? 'Time to call this customer' : 'Follow up now'),
          tag: f.id,
        })
        n.onclick = () => { window.focus(); openChat(f.conversation_id, f.order_id) }
      }
    }
    check()
    const t = setInterval(check, 30000)
    return () => clearInterval(t)
  }, [followups, conversations, openChat])
}
