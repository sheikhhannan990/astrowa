import { useCallback, useEffect, useState } from 'react'
import { supabase } from './utils/supabaseClient'
import { getCurrentStaffId, setCurrentStaffId } from './utils/currentStaff'
import { addTeamMember, errorText } from './utils/api'
import useWorkspaceData from './utils/useWorkspaceData'
import Inbox from './views/Inbox'
import Today from './views/Today'
import './App.css'

const NAV = [
  { id: 'today', label: 'Orders', icon: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11zM7 11h5v5H7z' },
  { id: 'inbox', label: 'Inbox', icon: 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z' },
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
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState(null)
  async function addMe(e) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const res = await addTeamMember({ name: name.trim(), role: 'agent' })
      onChoose(res.member.user_id)
    } catch (err) {
      setAddError(errorText(err))
      setBusy(false)
    }
  }
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
        <form className="who-add" onSubmit={addMe}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Not listed? Type your name" />
          <button type="submit" className="td-btn td-btn-primary" disabled={busy || !name.trim()}>Add</button>
        </form>
        {addError && <div className="login-error">{addError}</div>}
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

  const badges = { inbox: data.conversations.filter((c) => (c.unread_count || 0) > 0).length }
  const navItems = NAV

  let content
  if (view === 'today') content = <Today data={data} onOpen={openChat} onOrderUpdated={data.upsertOrder} />
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
