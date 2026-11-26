import { useEffect, useState } from 'react'
import { listTeam, addTeamMember, updateTeamMember, errorText } from '../utils/api'
import { formatPkt } from '../utils/workflow'
import './views.css'

// Admin: add team members by name, change roles, remove people who left.
export default function Team({ staff }) {
  const [team, setTeam] = useState([])
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', role: 'agent' })

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
          <div className="td-sub">The names people pick on their device, so the activity log shows who did what. Agents work orders and chats; admins also see Activity and Team and can delete chats.</div>
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
                <div className="td-small">added {formatPkt(m.created_at)}</div>
              </div>
              <span className={`td-flag ${m.role === 'admin' ? 'td-flag-bank' : ''}`}>{m.role === 'admin' ? 'Admin' : 'Agent'}</span>
              {!m.active && <span className="td-flag">Removed</span>}
              {m.user_id !== staff.user_id && (
                <div className="tm-actions">
                  <button type="button" className="td-btn" disabled={busy}
                    onClick={() => act(() => updateTeamMember(m.user_id, { active: !m.active }), m.active ? `${m.name} removed from the team list` : `${m.name} is back on the team list`)}>
                    {m.active ? 'Remove' : 'Bring back'}
                  </button>
                  <button type="button" className="td-btn" disabled={busy}
                    onClick={() => act(() => updateTeamMember(m.user_id, { role: m.role === 'admin' ? 'agent' : 'admin' }), 'Role updated')}>
                    Make {m.role === 'admin' ? 'agent' : 'admin'}
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
          act(() => addTeamMember(form), `${form.name} added — they can now pick their name on their device`)
            .then((done) => done && setForm({ name: '', role: 'agent' }))
        }}>
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
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
