import { useMemo } from 'react'
import { startOfTodayPKT, formatPkt, FLAG_LABELS } from '../utils/workflow'
import './views.css'

const OPEN_DAYS = 7
const SHOWN_FLAGS = ['refused_before', 'not_on_whatsapp', 'village_address', 'address_incomplete', 'invalid_phone', 'wrong_number']

function Count({ label, value, tone }) {
  return (
    <div className={`td-kpi td-tone-${tone || 'neutral'}`}>
      <span className="td-kpi-value">{value}</span>
      <span className="td-kpi-label">{label}</span>
    </div>
  )
}

function OrderRow({ order, conv, onOpen, showNote }) {
  const flags = (order.flags || []).filter((f) => SHOWN_FLAGS.includes(f))
  return (
    <button type="button" className="td-row" onClick={() => onOpen(order.conversation_id, order.id)} disabled={!order.conversation_id}>
      <span className="td-row-main">
        <span className="td-name">
          {order.customer_name || conv?.customer_name || 'Customer'}
          <span className="td-order">{order.order_number}</span>
          {order.payment_method === 'bank' && <span className="td-flag td-flag-bank">Bank</span>}
        </span>
        <span className="td-preview">{[order.city, formatPkt(order.order_created_at)].filter(Boolean).join(' · ')}</span>
        {flags.length > 0 && (
          <span className="td-flags">
            {flags.map((f) => <span key={f} className={`td-flag td-flag-${f}`}>{FLAG_LABELS[f]}</span>)}
          </span>
        )}
        {showNote && conv?.last_note && (
          <span className="td-note">📝 {conv.last_note} <span className="td-small">— {conv.last_note_by}, {formatPkt(conv.last_note_at)}</span></span>
        )}
      </span>
    </button>
  )
}

// Today: how many orders came in, and which ones still need confirming.
export default function Today({ data, onOpen }) {
  const { conversations, orders, loading, error } = data

  const view = useMemo(() => {
    const todayStart = startOfTodayPKT().getTime()
    const since = Date.now() - OPEN_DAYS * 86400000
    const convById = new Map(conversations.map((c) => [c.id, c]))
    const today = orders.filter((o) => Date.parse(o.order_created_at) >= todayStart)
    const pending = orders
      .filter((o) => o.stage === 'pending' && Date.parse(o.order_created_at) >= since)
      .sort((a, b) => Date.parse(a.order_created_at) - Date.parse(b.order_created_at))
    // A note written after the order came in means someone already tried.
    const tried = (o) => {
      const c = convById.get(o.conversation_id)
      return c?.last_note_at && Date.parse(c.last_note_at) >= Date.parse(o.order_created_at)
    }
    return {
      convById,
      today: today.length,
      confirmed: today.filter((o) => ['confirmed', 'shipped'].includes(o.stage)).length,
      cancelled: today.filter((o) => o.stage === 'cancelled').length,
      notOnWa: pending.filter((o) => (o.flags || []).includes('not_on_whatsapp')).length,
      toConfirm: pending.filter((o) => !tried(o)),
      followUp: pending.filter(tried),
      pending: pending.length,
    }
  }, [orders, conversations])

  const dateLabel = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="today">
      <div className="td-top">
        <div>
          <h1>Today</h1>
          <div className="td-sub">{dateLabel}</div>
        </div>
      </div>

      {error && <div className="td-error">Couldn't load: {error}</div>}

      <div className="td-kpis">
        <Count label="Orders today" value={view.today} />
        <Count label="Confirmed today" value={view.confirmed} tone="good" />
        <Count label="Still pending" value={view.pending} tone="warn" />
        <Count label="Cancelled today" value={view.cancelled} tone="bad" />
        <Count label="Not on WhatsApp" value={view.notOnWa} tone="warn" />
      </div>

      {loading && !orders.length ? <div className="td-empty">Loading…</div> : (
        <div className="td-grid">
          <section className="td-card">
            <header className="td-card-head">
              <h3>To confirm</h3>
              <span className="td-count">{view.toConfirm.length}</span>
            </header>
            <div className="td-hint">Pending orders nobody has checked yet. Open one, call or message, then add a note.</div>
            {view.toConfirm.length === 0 ? <div className="td-empty">All caught up. 🎉</div> : (
              <div className="td-rows">
                {view.toConfirm.map((o) => <OrderRow key={o.id} order={o} conv={view.convById.get(o.conversation_id)} onOpen={onOpen} />)}
              </div>
            )}
          </section>

          <section className="td-card">
            <header className="td-card-head">
              <h3>Follow up</h3>
              <span className="td-count">{view.followUp.length}</span>
            </header>
            <div className="td-hint">Still pending after a note — e.g. didn't pick up or didn't respond. Try again.</div>
            {view.followUp.length === 0 ? <div className="td-empty">Nothing to follow up.</div> : (
              <div className="td-rows">
                {view.followUp.map((o) => <OrderRow key={o.id} order={o} conv={view.convById.get(o.conversation_id)} onOpen={onOpen} showNote />)}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
