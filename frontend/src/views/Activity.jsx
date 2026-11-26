import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchPaged } from '../utils/supabaseClient'
import { startOfTodayPKT, formatPkt } from '../utils/workflow'
import './views.css'

const RANGES = [
  { id: 'today', label: 'Today', days: 0 },
  { id: 'yesterday', label: 'Yesterday', days: 1 },
  { id: 'week', label: 'Last 7 days', days: 7 },
]

const KIND_LABELS = {
  message: 'Message', call: 'Call', stage: 'Order', note: 'Note', followup: 'Reminder',
  status: 'Status', address: 'Address', flag: 'Flag', no_reply: 'No reply needed',
  delete: 'Delete', team: 'Team', quick_reply: 'Quick reply',
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function fmtMinutes(secs) {
  if (secs == null) return '—'
  const m = Math.round(secs / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function rangeBounds(id) {
  const today = startOfTodayPKT().getTime()
  if (id === 'yesterday') return [today - 86400000, today]
  if (id === 'week') return [today - 6 * 86400000, Date.now() + 60000]
  return [today, Date.now() + 60000]
}

// Admin oversight: per-person scorecard + full activity log.
export default function Activity({ data, onOpen }) {
  const [range, setRange] = useState('today')
  const [person, setPerson] = useState('all')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const [from, to] = rangeBounds(range)
    setLoading(true)
    fetchPaged((a, b) =>
      supabase
        .from('activity')
        .select('*')
        .gte('created_at', new Date(from).toISOString())
        .lt('created_at', new Date(to).toISOString())
        .order('created_at', { ascending: false })
        .range(a, b),
    5000)
      .then((r) => { if (!cancelled) { setRows(r); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range])

  const people = useMemo(() => {
    const by = new Map()
    for (const r of rows) {
      const key = r.actor_name || 'System'
      if (!by.has(key)) by.set(key, { name: key, messages: 0, replyTimes: [], calls: 0, confirmed: 0, cancelled: 0, reminders: 0, notes: 0, total: 0 })
      const p = by.get(key)
      p.total += 1
      const meta = r.meta || {}
      if (r.kind === 'message') {
        p.messages += 1
        if (meta.response_secs != null) p.replyTimes.push(meta.response_secs)
      }
      if (r.kind === 'call') {
        p.calls += 1
        if (meta.outcome === 'confirmed') p.confirmed += 1
        if (meta.outcome === 'cancelled') p.cancelled += 1
      }
      if (r.kind === 'stage') {
        if (/^(Confirmed|Marked)/.test(r.summary || '')) p.confirmed += 1
        if (/^Cancelled/.test(r.summary || '')) p.cancelled += 1
      }
      if (r.kind === 'followup' && /^Completed/.test(r.summary || '')) p.reminders += 1
      if (r.kind === 'note' && !/^Deleted/.test(r.summary || '')) p.notes += 1
    }
    return [...by.values()].sort((a, b) => b.total - a.total)
  }, [rows])

  const live = useMemo(() => ({
    waiting: data.conversations.filter((c) => c.needs_reply && !c.is_cancelled).length,
    overdue: data.followups.filter((f) => Date.parse(f.due_at) < Date.now()).length,
    pending: data.orders.filter((o) => o.stage === 'pending').length,
    oldestWait: data.conversations
      .filter((c) => c.needs_reply && !c.is_cancelled && c.waiting_since)
      .reduce((m, c) => Math.min(m, Date.parse(c.waiting_since)), Infinity),
  }), [data])

  const shown = person === 'all' ? rows : rows.filter((r) => (r.actor_name || 'System') === person)

  return (
    <div className="today activity">
      <div className="td-top">
        <div>
          <h1>Team activity</h1>
          <div className="td-sub">Who did what, and how fast customers got answers.</div>
        </div>
        <div className="ac-ranges" role="tablist">
          {RANGES.map((r) => (
            <button key={r.id} type="button" className={`td-pill ${range === r.id ? 'is-active' : ''}`} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="td-kpis">
        <div className="td-kpi td-tone-bad"><span className="td-kpi-value">{live.waiting}</span><span className="td-kpi-label">Waiting for reply now</span>
          {Number.isFinite(live.oldestWait) && <span className="td-kpi-hint">oldest {fmtMinutes((Date.now() - live.oldestWait) / 1000)}</span>}</div>
        <div className="td-kpi td-tone-warn"><span className="td-kpi-value">{live.overdue}</span><span className="td-kpi-label">Overdue reminders now</span></div>
        <div className="td-kpi"><span className="td-kpi-value">{live.pending}</span><span className="td-kpi-label">Orders still pending</span></div>
      </div>

      {error && <div className="td-error">Couldn't load activity: {error}</div>}

      <section className="td-card">
        <header className="td-card-head"><h3>Scorecard</h3></header>
        {loading ? <div className="td-empty">Loading…</div> : people.length === 0 ? (
          <div className="td-empty">No activity in this period.</div>
        ) : (
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Person</th><th>Messages</th><th>Typical reply time</th><th>Calls</th>
                  <th>Confirmed</th><th>Cancelled</th><th>Reminders done</th><th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.name} className={person === p.name ? 'is-selected' : ''} onClick={() => setPerson(person === p.name ? 'all' : p.name)}>
                    <td><strong>{p.name}</strong></td>
                    <td>{p.messages}</td>
                    <td>{fmtMinutes(median(p.replyTimes))}</td>
                    <td>{p.calls}</td>
                    <td>{p.confirmed}</td>
                    <td>{p.cancelled}</td>
                    <td>{p.reminders}</td>
                    <td>{p.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="td-small ac-foot">“Typical reply time” is the median time a customer waited before this person answered. Click a row to filter the log.</div>
      </section>

      <section className="td-card">
        <header className="td-card-head">
          <h3>Activity log</h3>
          <span className="td-count">{shown.length}</span>
          <span className="td-card-spacer" />
          <select className="ac-person" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Filter by person">
            <option value="all">Everyone</option>
            {people.map((p) => <option key={p.name}>{p.name}</option>)}
          </select>
        </header>
        <div className="ac-log">
          {shown.slice(0, 500).map((r) => (
            <button key={r.id} type="button" className="ac-entry" disabled={!r.conversation_id}
              onClick={() => r.conversation_id && onOpen(r.conversation_id, r.order_id)}>
              <span className="ac-time">{formatPkt(r.created_at, { noDate: range !== 'week' })}</span>
              <span className="ac-actor">{r.actor_name || 'System'}</span>
              <span className={`ac-kind ac-kind-${r.kind}`}>{KIND_LABELS[r.kind] || r.kind}</span>
              <span className="ac-summary">{r.summary}</span>
            </button>
          ))}
          {!loading && shown.length === 0 && <div className="td-empty">Nothing logged.</div>}
        </div>
      </section>
    </div>
  )
}
