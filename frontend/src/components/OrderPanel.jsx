import { useEffect, useMemo, useState } from 'react'
import {
  orderAction, createNote, deleteNote, createFollowup, completeFollowup, errorText,
} from '../utils/api'
import { loadQuickReplies } from './QuickReplies'
import {
  STAGE_LABELS, FLAG_LABELS, CALL_OUTCOMES, DEFAULT_CANCEL_REASONS, CANCEL_REASON_QUESTION,
  formatPkt, formatAge, windowHoursLeft, phoneForDialing, pktLocalInputToISO, isoToPktLocalInput,
  startOfTodayPKT, pktHour, deliveryDays,
} from '../utils/workflow'
import './OrderPanel.css'

const CALLING_START = 18

function nextCallingSlot(config) {
  const start = config?.calling_hours?.start ?? CALLING_START
  const end = config?.calling_hours?.end ?? 21
  const today = startOfTodayPKT()
  const slot = new Date(today.getTime() + start * 3600000)
  const h = pktHour()
  if (h < start) return slot
  if (h < end) return new Date(Date.now() + 3600000)
  return new Date(slot.getTime() + 86400000)
}

function Section({ title, children, right }) {
  return (
    <section className="op-section">
      <div className="op-section-head">
        <h4>{title}</h4>
        {right}
      </div>
      {children}
    </section>
  )
}

export default function OrderPanel({
  conversation, orders, followups, notes, config, staff, focusOrderId, onOrderUpdated, onClose, isMobile,
}) {
  const [activeId, setActiveId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [form, setForm] = useState(null) // { kind: 'call'|'cancel'|'address'|'reminder', outcome? }
  const [addressReplies, setAddressReplies] = useState([])
  const [noteText, setNoteText] = useState('')
  const [noteCustomer, setNoteCustomer] = useState(false)

  const order = useMemo(
    () => orders.find((o) => o.id === activeId) || orders.find((o) => o.id === focusOrderId) || orders[0] || null,
    [orders, activeId, focusOrderId],
  )
  const reasons = config?.cancel_reasons || DEFAULT_CANCEL_REASONS
  const windowLeft = windowHoursLeft(conversation.last_customer_message_at)
  const canMessage = windowLeft !== null && !conversation.is_not_on_whatsapp

  useEffect(() => {
    setActiveId(null)
    setForm(null)
    setError(null)
    setNotice(null)
  }, [conversation.id])

  useEffect(() => {
    loadQuickReplies()
      .then((items) => setAddressReplies(items.filter((q) => (q.category || '').toLowerCase() === 'address')))
      .catch(() => {})
  }, [])

  async function run(action, body = {}, successText) {
    if (!order || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await orderAction(order.id, action, body)
      if (res.order) onOrderUpdated?.(res.order)
      if (res.warning) setError(res.warning)
      else if (successText) setNotice(successText)
      setForm(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function addNote(e) {
    e.preventDefault()
    const body = noteText.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await createNote({
        conversation_id: conversation.id, order_id: order?.id, body, customer_level: noteCustomer,
      })
      setNoteText('')
      setNoteCustomer(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function addReminder(dueIso, note) {
    setBusy(true)
    try {
      await createFollowup({
        conversation_id: conversation.id, order_id: order?.id, due_at: dueIso, note, kind: 'call',
      })
      setForm(null)
      setNotice('Reminder set')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <div className="op-head">
      <div className="op-head-title">
        <span>Order</span>
        {orders.length > 1 && (
          <select
            className="op-order-select"
            value={order?.id || ''}
            onChange={(e) => setActiveId(e.target.value)}
            aria-label="Choose order"
          >
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.order_number} · {STAGE_LABELS[o.stage]}
              </option>
            ))}
          </select>
        )}
      </div>
      {onClose && (
        <button type="button" className="op-close" onClick={onClose} aria-label="Close order panel">×</button>
      )}
    </div>
  )

  if (!order) {
    return (
      <aside className={`order-panel ${isMobile ? 'is-mobile' : ''}`}>
        {header}
        <div className="op-empty">
          No Shopify order is linked to this chat yet. Orders placed from now on (and the last 10 days)
          appear here automatically.
        </div>
        {renderNotes()}
      </aside>
    )
  }

  const flags = order.flags || []
  const address = order.shipping_address || conversation.shipping_address || {}
  const orderFollowups = followups.filter((f) => !f.order_id || f.order_id === order.id)
  const isBank = order.payment_method === 'bank'

  function renderNotes() {
    const list = notes || []
    return (
      <Section title={`Notes${list.length ? ` (${list.length})` : ''}`}>
        <form className="op-note-form" onSubmit={addNote}>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Internal note — never sent to the customer"
            rows={2}
          />
          <div className="op-note-row">
            <label className="op-check">
              <input type="checkbox" checked={noteCustomer} onChange={(e) => setNoteCustomer(e.target.checked)} />
              Show on all this customer's orders
            </label>
            <button type="submit" className="op-btn op-btn-primary" disabled={!noteText.trim() || busy}>
              Add note
            </button>
          </div>
        </form>
        {list.map((n) => (
          <div key={n.id} className="op-note">
            <div className="op-note-body">{n.body}</div>
            <div className="op-note-meta">
              {n.phone && <span className="op-chip op-chip-customer">Customer note</span>}
              {n.author_name} · {formatPkt(n.created_at)}
              {(n.author_id === staff?.user_id || staff?.role === 'admin') && (
                <button type="button" className="op-link" onClick={() => deleteNote(n.id).catch((e) => setError(errorText(e)))}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </Section>
    )
  }

  return (
    <aside className={`order-panel ${isMobile ? 'is-mobile' : ''}`}>
      {header}
      <div className="op-scroll">
        {(error || notice) && (
          <div className={`op-banner ${error ? 'is-error' : 'is-ok'}`} role="status">
            <span>{error || notice}</span>
            <button type="button" onClick={() => { setError(null); setNotice(null) }} aria-label="Dismiss">×</button>
          </div>
        )}

        {/* ---------- Summary ---------- */}
        <div className="op-summary">
          <div className="op-summary-top">
            <span className="op-number">{order.order_number}</span>
            <span className={`op-stage op-stage-${order.stage}`}>{STAGE_LABELS[order.stage]}</span>
            <span className={`op-chip ${isBank ? 'op-chip-bank' : ''}`}>{isBank ? 'Bank deposit' : 'COD'}</span>
          </div>
          <div className="op-items">{order.items_text}</div>
          <div className="op-meta">
            {order.total ? <strong>Rs. {Math.round(order.total).toLocaleString('en-PK')}</strong> : null}
            <span>· placed {formatAge(order.order_created_at)} ago</span>
            {conversation.order_count > 1 && <span className="op-chip op-chip-repeat">{conversation.order_count} orders</span>}
          </div>
          {order.stage === 'cancelled' && order.cancel_reason && (
            <div className="op-reason">Reason: {order.cancel_reason}</div>
          )}
          {order.stage_changed_by && (
            <div className="op-muted">
              {STAGE_LABELS[order.stage]} by {order.stage_changed_by}
              {order.confirmed_via && order.stage !== 'pending' ? ` (${order.confirmed_via})` : ''}
              {order.stage_changed_at ? ` · ${formatPkt(order.stage_changed_at)}` : ''}
            </div>
          )}
          {flags.length > 0 && (
            <div className="op-flags">
              {flags.map((f) => (
                <span key={f} className={`op-flag op-flag-${f}`}>
                  ⚠ {FLAG_LABELS[f] || f}
                  <button type="button" title="Clear" onClick={() => run('clear_flag', { flag: f })} aria-label="Clear flag">×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ---------- Stage actions ---------- */}
        <div className="op-actions">
          {order.stage === 'pending' && (
            <>
              {isBank ? (
                <button type="button" className="op-btn op-btn-primary" disabled={busy}
                  onClick={() => run('mark_paid', { notify: canMessage }, canMessage ? 'Marked paid & customer notified' : 'Marked paid')}>
                  ✓ Mark paid{canMessage ? ' & notify' : ''}
                </button>
              ) : (
                <button type="button" className="op-btn op-btn-primary" disabled={busy} onClick={() => run('confirm', {}, 'Order confirmed')}>
                  ✓ Confirm
                </button>
              )}
              <button type="button" className="op-btn op-btn-danger" disabled={busy} onClick={() => setForm({ kind: 'cancel' })}>
                Cancel…
              </button>
            </>
          )}
          {order.stage === 'confirmed' && (
            <>
              <button type="button" className="op-btn op-btn-danger" disabled={busy} onClick={() => setForm({ kind: 'cancel' })}>Cancel…</button>
              <button type="button" className="op-btn" disabled={busy} onClick={() => run('reopen', {}, 'Back to pending')}>Back to pending</button>
            </>
          )}
          {order.stage === 'cancelled' && (
            <button type="button" className="op-btn" disabled={busy} onClick={() => run('reopen', {}, 'Order reopened')}>Reopen order</button>
          )}
          {order.stage === 'shipped' && order.tracking_number && (
            <a className="op-btn" href={`https://postex.pk/tracking?cn=${encodeURIComponent(order.tracking_number)}`} target="_blank" rel="noreferrer">
              Track {order.tracking_number}
            </a>
          )}
        </div>
        {form?.kind === 'cancel' && (
          <CancelForm reasons={reasons} busy={busy} onCancel={() => setForm(null)}
            onSubmit={(reason) => run('cancel', { reason }, 'Order cancelled')} />
        )}

        {/* ---------- Call ---------- */}
        <Section
          title="Call"
          right={order.call_attempts ? (
            <span className="op-muted">
              {order.call_attempts} call{order.call_attempts > 1 ? 's' : ''} · last: {CALL_OUTCOMES.find((c) => c.id === order.last_call_outcome)?.label || '—'}
            </span>
          ) : null}
        >
          <a className="op-call" href={`tel:${phoneForDialing(conversation.phone)}`}>
            📞 Call {phoneForDialing(conversation.phone)}
          </a>
          <div className="op-outcomes">
            {CALL_OUTCOMES.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`op-outcome op-tone-${o.tone}`}
                disabled={busy}
                onClick={() => {
                  if (['call_back', 'cancelled', 'confirmed', 'address_corrected'].includes(o.id)) setForm({ kind: 'call', outcome: o.id })
                  else run('call', { outcome: o.id }, `Logged: ${o.label}`)
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          {form?.kind === 'call' && (
            <CallForm outcome={form.outcome} reasons={reasons} config={config} busy={busy}
              onCancel={() => setForm(null)}
              onSubmit={(body) => run('call', { outcome: form.outcome, ...body },
                `Logged: ${CALL_OUTCOMES.find((c) => c.id === form.outcome)?.label}`)} />
          )}
        </Section>

        {/* ---------- Message the customer ---------- */}
        <Section
          title="Message customer"
          right={<span className={`op-window ${canMessage ? '' : 'is-closed'}`}>
            {canMessage ? `Free reply window: ${Math.floor(windowLeft)}h left` : 'Window closed — call instead'}
          </span>}
        >
          <div className="op-actions">
            <button type="button" className="op-btn" disabled={!canMessage || busy}
              onClick={() => run('send', { message: CANCEL_REASON_QUESTION, flag: 'cancel_requested', followup_hours: 3 }, 'Asked for cancellation reason')}>
              Ask cancel reason
            </button>
            {isBank && order.stage === 'pending' && (
              <button type="button" className="op-btn" disabled={!canMessage || busy}
                onClick={() => run('send', {
                  message: 'Payment is pending at your end. Please make payment to the account mentioned above and share a screenshot with us.',
                  flag: 'payment_pending', followup_hours: 3,
                }, 'Payment reminder sent')}>
                Payment not received
              </button>
            )}
          </div>
          {addressReplies.length > 0 && (
            <div className="op-addr-replies">
              <span className="op-muted">Address problem:</span>
              {addressReplies.map((q) => (
                <button key={q.id} type="button" className="op-btn op-btn-small" disabled={!canMessage || busy}
                  title={q.body}
                  onClick={() => run('send', { message: q.body, quick_reply_id: q.id, flag: 'address_issue', followup_hours: 3 }, `Sent “${q.title}”`)}>
                  {q.title}
                </button>
              ))}
            </div>
          )}
          <div className="op-muted op-hint">These send a WhatsApp message and set a reminder if the customer doesn't reply in 3 hours.</div>
        </Section>

        {/* ---------- Address ---------- */}
        <Section
          title="Delivery address"
          right={<button type="button" className="op-link" onClick={() => setForm(form?.kind === 'address' ? null : { kind: 'address' })}>
            {form?.kind === 'address' ? 'Close' : 'Edit'}
          </button>}
        >
          {form?.kind === 'address' ? (
            <AddressForm address={address} busy={busy} onCancel={() => setForm(null)}
              onSubmit={(fields) => run('edit_address', fields, 'Address updated')} />
          ) : (
            <div className="op-address">
              {[address.name, address.address1, address.address2,
                [address.city, address.province].filter(Boolean).join(', ')].filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}
              <div className="op-muted">Delivery: {deliveryDays(order.city || address.city, config)} working days</div>
            </div>
          )}
        </Section>

        {/* ---------- Reminders ---------- */}
        <Section
          title="Reminders"
          right={<button type="button" className="op-link" onClick={() => setForm(form?.kind === 'reminder' ? null : { kind: 'reminder' })}>
            {form?.kind === 'reminder' ? 'Close' : '+ Add'}
          </button>}
        >
          {form?.kind === 'reminder' && (
            <ReminderForm config={config} busy={busy} onCancel={() => setForm(null)} onSubmit={addReminder} />
          )}
          {orderFollowups.length === 0 && form?.kind !== 'reminder' && <div className="op-muted">No open reminders.</div>}
          {orderFollowups.map((f) => {
            const overdue = Date.parse(f.due_at) < Date.now()
            return (
              <div key={f.id} className={`op-reminder ${overdue ? 'is-overdue' : ''}`}>
                <div>
                  <div className="op-reminder-when">{overdue ? 'Overdue · ' : ''}{formatPkt(f.due_at)}</div>
                  <div className="op-reminder-note">{f.note || (f.kind === 'call' ? 'Call customer' : 'Follow up')}</div>
                </div>
                <button type="button" className="op-btn op-btn-small" onClick={() => completeFollowup(f.id).catch((e) => setError(errorText(e)))}>
                  Done
                </button>
              </div>
            )
          })}
        </Section>

        {renderNotes()}

        {orders.length > 1 && (
          <Section title="Customer's orders">
            {orders.map((o) => (
              <button key={o.id} type="button" className={`op-history ${o.id === order.id ? 'is-current' : ''}`} onClick={() => setActiveId(o.id)}>
                <span>{o.order_number}</span>
                <span className={`op-stage op-stage-${o.stage}`}>{STAGE_LABELS[o.stage]}</span>
                <span className="op-muted">{formatPkt(o.order_created_at)}</span>
              </button>
            ))}
          </Section>
        )}
      </div>
    </aside>
  )
}

function CancelForm({ reasons, busy, onSubmit, onCancel }) {
  const [reason, setReason] = useState(reasons[0])
  return (
    <div className="op-form">
      <label className="op-label">Cancellation reason</label>
      <select value={reason} onChange={(e) => setReason(e.target.value)}>
        {reasons.map((r) => <option key={r}>{r}</option>)}
      </select>
      <div className="op-form-actions">
        <button type="button" className="op-btn" onClick={onCancel}>Back</button>
        <button type="button" className="op-btn op-btn-danger" disabled={busy} onClick={() => onSubmit(reason)}>Cancel order</button>
      </div>
    </div>
  )
}

function CallForm({ outcome, reasons, config, busy, onSubmit, onCancel }) {
  const [when, setWhen] = useState(isoToPktLocalInput(nextCallingSlot(config)))
  const [reason, setReason] = useState(reasons[0])
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const needsAddress = outcome === 'address_corrected'
  const submit = () => {
    const body = { note: note.trim() || undefined }
    if (outcome === 'call_back') body.callback_at = pktLocalInputToISO(when)
    if (outcome === 'cancelled') body.reason = reason
    if (address.trim()) body.address = address.trim()
    onSubmit(body)
  }
  return (
    <div className="op-form">
      {outcome === 'call_back' && (
        <>
          <label className="op-label">Call back at (Pakistan time)</label>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </>
      )}
      {outcome === 'cancelled' && (
        <>
          <label className="op-label">Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => <option key={r}>{r}</option>)}
          </select>
        </>
      )}
      {(outcome === 'confirmed' || needsAddress) && (
        <>
          <label className="op-label">{needsAddress ? 'Correct address' : 'Corrected address (optional)'}</label>
          <textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="House, street, area, nearby landmark" />
        </>
      )}
      <label className="op-label">Note (optional)</label>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. wants delivery after 5pm" />
      <div className="op-form-actions">
        <button type="button" className="op-btn" onClick={onCancel}>Back</button>
        <button type="button" className="op-btn op-btn-primary" disabled={busy || (needsAddress && !address.trim())} onClick={submit}>
          Save
        </button>
      </div>
    </div>
  )
}

function AddressForm({ address, busy, onSubmit, onCancel }) {
  const [a1, setA1] = useState(address.address1 || '')
  const [a2, setA2] = useState(address.address2 || '')
  const [city, setCity] = useState(address.city || '')
  return (
    <div className="op-form">
      <label className="op-label">Address</label>
      <textarea rows={2} value={a1} onChange={(e) => setA1(e.target.value)} />
      <label className="op-label">Landmark / line 2</label>
      <input value={a2} onChange={(e) => setA2(e.target.value)} />
      <label className="op-label">City</label>
      <input value={city} onChange={(e) => setCity(e.target.value)} />
      <div className="op-form-actions">
        <button type="button" className="op-btn" onClick={onCancel}>Back</button>
        <button type="button" className="op-btn op-btn-primary" disabled={busy || !a1.trim()}
          onClick={() => onSubmit({ address1: a1, address2: a2, city })}>Save address</button>
      </div>
      <div className="op-muted op-hint">Updates the address here. Remember to update it in Shopify too.</div>
    </div>
  )
}

function ReminderForm({ config, busy, onSubmit, onCancel }) {
  const slot = nextCallingSlot(config)
  const [when, setWhen] = useState(isoToPktLocalInput(slot))
  const [note, setNote] = useState('')
  const presets = [
    { label: 'In 1 hour', date: new Date(Date.now() + 3600000) },
    { label: 'Next calling slot', date: slot },
    { label: 'Tomorrow 6pm', date: new Date(startOfTodayPKT().getTime() + 86400000 + 18 * 3600000) },
  ]
  return (
    <div className="op-form">
      <div className="op-presets">
        {presets.map((p) => (
          <button key={p.label} type="button" className="op-btn op-btn-small" onClick={() => setWhen(isoToPktLocalInput(p.date))}>
            {p.label}
          </button>
        ))}
      </div>
      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to do (e.g. call to confirm address)" />
      <div className="op-form-actions">
        <button type="button" className="op-btn" onClick={onCancel}>Back</button>
        <button type="button" className="op-btn op-btn-primary" disabled={busy || !when}
          onClick={() => onSubmit(pktLocalInputToISO(when), note.trim() || undefined)}>Set reminder</button>
      </div>
    </div>
  )
}
