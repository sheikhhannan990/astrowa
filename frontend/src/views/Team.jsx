import { useEffect, useState } from 'react'
import { listTeam, addTeamMember, updateTeamMember, errorText } from '../utils/api'
import { formatPkt } from '../utils/workflow'
import './views.css'

// Admin: add team members, change roles, reset passwords, switch off access.
export default function Team({ staff }) {
  const [team, setTeam] = useState([])
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'agent' })

  const load = () => listTeam().then((r) => setTeam(r.team || [])).catch((e) => setError(errorText(e)))
  useEffect(() => { load() }, [])

  async function act(fn, ok) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(ok)
      await load()
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="today team">
      <div className="td-top">
        <div>
          <h1>Team</h1>
          <div className="td-sub">Everyone who can log in to the inbox. Agents can work orders and chats; only admins can delete chats, manage the team and see activity.</div>
        </div>
      </div>
      {error && <div className="td-error">{error}</div>}
      {notice && <div className="td-ok">{notice}</div>}

      <section className="td-card">
        <header className="td-card-head"><h3>Members</h3><span className="td-count">{team.length}</span></header>
        <div className="tm-list">
          {team.map((m) => (
            <div key={m.user_id} className={`tm-row ${m.active ? '' : 'is-off'}`}>
              <div className="tm-who">
                <strong>{m.name}</strong> {m.user_id === staff.user_id && <span className="td-small">(you)</span>}
                <div className="td-small">{m.email} · added {formatPkt(m.created_at)}</div>
              </div>
              <span className={`td-flag ${m.role === 'admin' ? 'td-flag-bank' : ''}`}>{m.role === 'admin' ? 'Admin' : 'Agent'}</span>
              {!m.active && <span className="td-flag">No access</span>}
              {m.user_id !== staff.user_id && (
                <div className="tm-actions">
                  <button type="button" className="td-btn" disabled={busy}
                    onClick={() => act(() => updateTeamMember(m.user_id, { active: !m.active }), m.active ? `${m.name} can no longer log in` : `${m.name} has access again`)}>
                    {m.active ? 'Remove access' : 'Give access'}
                  </button>
                  <button type="button" className="td-btn" disabled={busy}
                    onClick={() => act(() => updateTeamMember(m.user_id, { role: m.role === 'admin' ? 'agent' : 'admin' }), 'Role updated')}>
                    Make {m.role === 'admin' ? 'agent' : 'admin'}
                  </button>
                  <button type="button" className="td-btn" disabled={busy}
                    onClick={() => {
                      const pw = window.prompt(`New password for ${m.name} (at least 8 characters):`)
                      if (pw) act(() => updateTeamMember(m.user_id, { password: pw }), 'Password changed')
                    }}>
                    Reset password
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="td-card">
        <header className="td-card-head"><h3>Add a team member</h3></header>
        <form className="tm-form" onSubmit={(e) => {
          e.preventDefault()
          act(() => addTeamMember(form), `${form.name} added — share their email and password with them`)
            .then((done) => done && setForm({ name: '', email: '', password: '', role: 'agent' }))
        }}>
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <input placeholder="Password (8+ characters)" type="text" minLength={8} value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="agent">Agent</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" className="td-btn td-btn-primary" disabled={busy}>Add member</button>
        </form>
      </section>
    </div>
  )
}
