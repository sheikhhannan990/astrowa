import { useEffect, useMemo, useState } from 'react'
import {
  startOfTodayPKT, pktHour, formatAge, formatPkt, windowHoursLeft,
  FLAG_LABELS, STAGE_LABELS, CALL_OUTCOMES,
} from '../utils/workflow'
import './views.css'

const QUEUE_DAYS = 7
const CALL_AFTER_MS = 2 * 3600000
const URGENT_FLAGS = ['not_on_whatsapp', 'whatsapp_failed', 'invalid_phone', 'address_incomplete', 'village_address', 'no_city']
const PARKED_FLAGS = ['unreachable', 'wrong_number']

function useTick(ms = 60000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function Kpi({ label, value, tone, hint, onClick }) {
  return (
    <button type="button" className={`td-kpi td-tone-${tone || 'neutral'}`} onClick={onClick} disabled={!onClick}>
      <span className="td-kpi-value">{value}</span>
      <span className="td-kpi-label">{label}</span>
      {hint && <span className="td-kpi-hint">{hint}</span>}
    </button>
  )
}

function Card({ id, title, count, children, empty, action }) {
  return (
    <section className="td-card" id={id}>
      <header className="td-card-head">
        <h3>{title}</h3>
        {count > 0 && <span className="td-count">{count}</span>}
        <span className="td-card-spacer" />
        {action}
      </header>
      {count === 0 ? <div className="td-empty">{empty}</div> : <div className="td-rows">{children}</div>}
    </section>
  )
}

function Flags({ flags }) {
  const shown = (flags || []).filter((f) => FLAG_LABELS[f])
  if (!shown.length) return null
  return (
    <span className="td-flags">
      {shown.map((f) => <span key={f} className="td-flag">{FLAG_LABELS[f]}</span>)}
    </span>
  )
}

export default function Today({ data, staff, onOpen }) {
  const { conversations, orders, followups, config, loading, error } = data
  const now = useTick()
  const [showAllToday, setShowAllToday] = useState(false)
  const [notifyPerm, setNotifyPerm] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )

  const calling = config?.calling_hours || { start: 18, end: 21 }
  const hour = pktHour(now)
  const inCallingHours = hour >= calling.start && hour < calling.end

  const view = useMemo(() => {
    const todayStart = startOfTodayPKT(now).getTime()
    const todayEnd = todayStart + 86400000
    const queueSince = now - QUEUE_DAYS * 86400000
    const convById = new Map(conversations.map((c) => [c.id, c]))

    const today = orders.filter((o) => Date.parse(o.order_created_at) >= todayStart)
    const count = (stage) => today.filter((o) => o.stage === stage).length
    const openPending = orders.filter((o) => o.stage === 'pending' && Date.parse(o.order_created_at) >= queueSince)

    const scheduled = new Set(
      followups.filter((f) => f.order_id && Date.parse(f.due_at) > now).map((f) => f.order_id),
    )
    const toCall = openPending
      .filter((o) => !(o.flags || []).some((f) => PARKED_FLAGS.includes(f)))
      .filter((o) => !scheduled.has(o.id))
      .filter((o) => now - Date.parse(o.order_created_at) > CALL_AFTER_MS ||
        (o.flags || []).some((f) => URGENT_FLAGS.includes(f)))
      .sort((a, b) => Date.parse(a.order_created_at) - Date.parse(b.order_created_at))
    const parked = openPending.filter((o) => (o.flags || []).some((f) => PARKED_FLAGS.includes(f)))

    const waiting = conversations
      .filter((c) => c.needs_reply && !c.is_cancelled)
      .sort((a, b) => Date.parse(a.waiting_since || a.last_customer_message_at || 0) -
        Date.parse(b.waiting_since || b.last_customer_message_at || 0))

    const due = followups.filter((f) => Date.parse(f.due_at) < todayEnd)
    const overdue = due.filter((f) => Date.parse(f.due_at) < now)
    const orderById = new Map(orders.map((o) => [o.id, o]))

    return {
      today, convById, orderById, toCall, parked, waiting, due, overdue,
      confirmed: count('confirmed') + count('shipped'),
      pendingToday: count('pending'),
      cancelled: count('cancelled'),
      notOnWa: openPending.filter((o) => (o.flags || []).includes('not_on_whatsapp')).length,
      openPending: openPending.length,
    }
  }, [orders, conversations, followups, now])

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const nameOf = (o) => o?.customer_name || view.convById.get(o?.conversation_id)?.customer_name || 'Customer'
  const todayLabel = new Date(now).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="today">
      <div className="td-top">
        <div>
          <h1>Today</h1>
          <div className="td-sub">{todayLabel} · signed in as {staff?.name}</div>
        </div>
        {notifyPerm === 'default' && (
          <button type="button" className="td-btn" onClick={() => Notification.requestPermission().then(setNotifyPerm)}>
            🔔 Turn on reminder alerts
          </button>
        )}
      </div>

      {error && <div className="td-error">Couldn't load: {error}</div>}

      <div className="td-kpis">
        <Kpi label="Orders today" value={view.today.length} />
        <Kpi label="Confirmed" value={view.confirmed} tone="good" />
        <Kpi label="Pending (all open)" value={view.openPending} tone="warn" hint={`${view.pendingToday} from today`} onClick={() => scrollTo('td-call')} />
        <Kpi label="Cancelled today" value={view.cancelled} tone="bad" />
        <Kpi label="Not on WhatsApp" value={view.notOnWa} tone="warn" onClick={() => scrollTo('td-call')} />
        <Kpi label="Waiting for reply" value={view.waiting.length} tone={view.waiting.length ? 'bad' : 'good'} onClick={() => scrollTo('td-waiting')} />
        <Kpi label="Reminders due" value={view.due.length} tone={view.overdue.length ? 'bad' : 'neutral'}
          hint={view.overdue.length ? `${view.overdue.length} overdue` : null} onClick={() => scrollTo('td-reminders')} />
      </div>

      <div className={`td-callbar ${inCallingHours ? 'is-live' : ''}`}>
        {inCallingHours
          ? <>📞 <strong>Calling hours now</strong> (6–9pm) · {view.toCall.length} customer{view.toCall.length === 1 ? '' : 's'} to call</>
          : <>📞 Calling hours are 6–9pm · {view.toCall.length} customer{view.toCall.length === 1 ? '' : 's'} queued for calls{hour < calling.start ? ' — reply to chats until then' : ''}</>}
      </div>

      {loading && !orders.length ? <div className="td-empty">Loading…</div> : (
        <div className="td-grid">
          <Card id="td-waiting" title="Customers waiting for a reply" count={view.waiting.length} empty="Nobody is waiting. 🎉">
            {view.waiting.map((c) => {
              const waited = formatAge(c.waiting_since || c.last_customer_message_at, now)
              const late = now - Date.parse(c.waiting_since || 0) > 3600000
              const left = windowHoursLeft(c.last_customer_message_at, now)
              return (
                <button key={c.id} type="button" className="td-row" onClick={() => onOpen(c.id)}>
                  <span className="td-row-main">
                    <span className="td-name">{c.customer_name || c.phone}</span>
                    <span className="td-preview">{c.last_message}</span>
                  </span>
                  <span className="td-row-side">
                    <span className={`td-wait ${late ? 'is-late' : ''}`}>⏱ {waited}</span>
                    {left !== null && left < 6 && <span className="td-small td-bad">window closes in {Math.max(1, Math.floor(left))}h</span>}
                  </span>
                </button>
              )
            })}
          </Card>

          <Card id="td-reminders" title="Reminders due today" count={view.due.length} empty="No reminders due today.">
            {view.due.map((f) => {
              const o = view.orderById.get(f.order_id)
              const c = view.convById.get(f.conversation_id)
              const overdue = Date.parse(f.due_at) < now
              return (
                <button key={f.id} type="button" className="td-row" onClick={() => onOpen(f.conversation_id, f.order_id)}>
                  <span className="td-row-main">
                    <span className="td-name">{c?.customer_name || nameOf(o)} {o && <span className="td-order">{o.order_number}</span>}</span>
                    <span className="td-preview">{f.note || (f.kind === 'call' ? 'Call customer' : 'Follow up')}</span>
                  </span>
                  <span className="td-row-side">
                    <span className={`td-when ${overdue ? 'td-bad' : ''}`}>{overdue ? 'Overdue · ' : ''}{formatPkt(f.due_at, { noDate: !overdue })}</span>
                  </span>
                </button>
              )
            })}
          </Card>

          <Card id="td-call" title="To call — unconfirmed orders" count={view.toCall.length}
            empty="No orders waiting for a call.">
            {view.toCall.map((o) => (
              <button key={o.id} type="button" className="td-row" onClick={() => onOpen(o.conversation_id, o.id)} disabled={!o.conversation_id}>
                <span className="td-row-main">
                  <span className="td-name">{nameOf(o)} <span className="td-order">{o.order_number}</span>
                    {o.payment_method === 'bank' && <span className="td-flag td-flag-bank">Bank</span>}</span>
                  <span className="td-preview">
                    {o.call_attempts
                      ? `${o.call_attempts} call${o.call_attempts > 1 ? 's' : ''} · last: ${CALL_OUTCOMES.find((c) => c.id === o.last_call_outcome)?.label || '—'}`
                      : `Placed ${formatAge(o.order_created_at, now)} ago · ${o.city || ''}`}
                  </span>
                  <Flags flags={o.flags} />
                </span>
                <span className="td-row-side"><span className="td-small">{formatAge(o.order_created_at, now)}</span></span>
              </button>
            ))}
          </Card>

          {view.parked.length > 0 && (
            <Card title="Unreachable / wrong number — decide" count={view.parked.length} empty="">
              {view.parked.map((o) => (
                <button key={o.id} type="button" className="td-row" onClick={() => onOpen(o.conversation_id, o.id)} disabled={!o.conversation_id}>
                  <span className="td-row-main">
                    <span className="td-name">{nameOf(o)} <span className="td-order">{o.order_number}</span></span>
                    <span className="td-preview">{o.call_attempts} attempts · cancel or keep trying?</span>
                    <Flags flags={o.flags} />
                  </span>
                </button>
              ))}
            </Card>
          )}

          <Card title="All orders today" count={view.today.length} empty="No orders yet today."
            action={view.today.length > 6 && (
              <button type="button" className="td-link" onClick={() => setShowAllToday((v) => !v)}>
                {showAllToday ? 'Show less' : 'Show all'}
              </button>
            )}>
            {(showAllToday ? view.today : view.today.slice(0, 6)).map((o) => (
              <button key={o.id} type="button" className="td-row" onClick={() => onOpen(o.conversation_id, o.id)} disabled={!o.conversation_id}>
                <span className="td-row-main">
                  <span className="td-name">{nameOf(o)} <span className="td-order">{o.order_number}</span></span>
                  <span className="td-preview">{o.items_text}</span>
                </span>
                <span className="td-row-side">
                  <span className={`td-stage td-stage-${o.stage}`}>{STAGE_LABELS[o.stage]}</span>
                  <span className="td-small">{formatPkt(o.order_created_at, { noDate: true })}</span>
                </span>
              </button>
            ))}
          </Card>
        </div>
      )}
    </div>
  )
}
