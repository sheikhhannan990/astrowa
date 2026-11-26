import { useEffect, useState } from 'react'
import { orderAction, createNote, errorText } from '../utils/api'
import {
  STAGE_LABELS, FLAG_LABELS, NOTE_PRESETS, DEFAULT_CANCEL_REASONS,
  formatPkt, phoneForDialing, deliveryDays,
} from '../utils/workflow'
import './OrderPanel.css'

// Warnings worth showing the agent (the rest are internal bookkeeping).
const SHOWN_FLAGS = ['refused_before', 'not_on_whatsapp', 'village_address', 'address_incomplete', 'no_city', 'invalid_phone', 'wrong_number']

// Order details + notes for one chat. Kept deliberately simple: what the
// order is, the one or two buttons that matter for its status, and notes.
export default function OrderPanel({ conversation, orders, notes, config, focusOrderId, onOrderUpdated, onClose, isMobile }) {
  const [activeId, setActiveId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setActiveId(null)
    setCancelling(false)
    setError(null)
    setNoteText('')
  }, [conversation.id])

  const order = orders.find((o) => o.id === activeId) || orders.find((o) => o.id === focusOrderId) || orders[0] || null
  const reasons = config?.cancel_reasons || DEFAULT_CANCEL_REASONS

  async function run(action, body = {}) {
    if (!order || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await orderAction(order.id, action, body)
      if (res.order) onOrderUpdated?.(res.order)
      if (res.warning) setError(res.warning)
      setCancelling(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function addNote(text) {
    const body = (text || '').trim()
    if (!body || busy) return
    setBusy(true)
    setError(null)
    try {
      await createNote({ conversation_id: conversation.id, order_id: order?.id, body })
      setNoteText('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const address = order?.shipping_address || conversation.shipping_address || {}
  const addressLines = [address.address1, address.address2, [address.city, address.province].filter(Boolean).join(', ')].filter(Boolean)
  const flags = (order?.flags || []).filter((f) => SHOWN_FLAGS.includes(f))
  const isBank = order?.payment_method === 'bank'

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText([address.name, ...addressLines, conversation.phone].filter(Boolean).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — nothing to do */
    }
  }

  return (
    <aside className={`order-panel ${isMobile ? 'is-mobile' : ''}`}>
      <div className="op-head">
        <div className="op-head-title">
          {order ? (
            <>
              <span className="op-number">{order.order_number}</span>
              <span className={`op-stage op-stage-${order.stage}`}>{STAGE_LABELS[order.stage]}</span>
            </>
          ) : <span>Order</span>}
        </div>
        {onClose && <button type="button" className="op-close" onClick={onClose} aria-label="Close">×</button>}
      </div>

      <div className="op-scroll">
        {error && (
          <div className="op-banner is-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        {!order ? (
          <div className="op-empty">No order linked to this chat.</div>
        ) : (
          <>
            {flags.length > 0 && (
              <div className="op-flags">
                {flags.map((f) => <span key={f} className={`op-flag op-flag-${f}`}>⚠ {FLAG_LABELS[f]}</span>)}
              </div>
            )}

            <div className="op-summary">
              <div className="op-items">{order.items_text}</div>
              <div className="op-meta">
                <strong>Rs. {Math.round(order.total || 0).toLocaleString('en-PK')}</strong>
                <span>· {isBank ? 'Bank deposit' : 'COD'}</span>
                <span>· {formatPkt(order.order_created_at)}</span>
              </div>
              {order.stage === 'cancelled' && order.cancel_reason && <div className="op-reason">Reason: {order.cancel_reason}</div>}
            </div>

            <div className="op-address">
              {addressLines.map((l, i) => <div key={i}>{l}</div>)}
              <div className="op-address-foot">
                <span className="op-muted">Delivery {deliveryDays(order.city || address.city, config)} days</span>
                <button type="button" className="op-link" onClick={copyAddress}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
            </div>

            {/* The buttons that matter for this order's status */}
            <div className="op-actions">
              <a className="op-btn op-btn-call" href={`tel:${phoneForDialing(conversation.phone)}`}>📞 Call</a>
              {order.stage === 'pending' && (isBank ? (
                <button type="button" className="op-btn op-btn-primary" disabled={busy} onClick={() => run('mark_paid', { notify: true })}>✓ Mark paid</button>
              ) : (
                <button type="button" className="op-btn op-btn-primary" disabled={busy} onClick={() => run('confirm')}>✓ Confirm</button>
              ))}
              {['pending', 'confirmed'].includes(order.stage) && (
                <button type="button" className="op-btn op-btn-danger" disabled={busy} onClick={() => setCancelling((v) => !v)}>Cancel</button>
              )}
              {order.stage === 'shipped' && (
                <>
                  {order.tracking_number && (
                    <a className="op-btn" href={`https://postex.pk/tracking?cn=${encodeURIComponent(order.tracking_number)}`} target="_blank" rel="noreferrer">Track</a>
                  )}
                  <button type="button" className="op-btn op-btn-danger" disabled={busy}
                    title="Customer refused / parcel came back. Their next order will ask for advance."
                    onClick={() => window.confirm(`Mark ${order.order_number} as returned? Their next order will be flagged "Refused before".`) && run('returned')}>
                    Returned
                  </button>
                </>
              )}
              {['cancelled', 'returned'].includes(order.stage) && (
                <button type="button" className="op-btn" disabled={busy} onClick={() => run('reopen')}>Reopen</button>
              )}
            </div>
            {cancelling && (
              <div className="op-cancel">
                <span className="op-muted">Why is it cancelled?</span>
                <div className="op-chips">
                  {reasons.map((r) => (
                    <button key={r} type="button" className="op-chip-btn" disabled={busy} onClick={() => run('cancel', { reason: r })}>{r}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Notes */}
        <section className="op-notes">
          <h4>Notes</h4>
          <div className="op-chips">
            {NOTE_PRESETS.map((p) => (
              <button key={p} type="button" className="op-chip-btn" disabled={busy} onClick={() => addNote(p)}>{p}</button>
            ))}
          </div>
          <form className="op-note-form" onSubmit={(e) => { e.preventDefault(); addNote(noteText) }}>
            <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Write a note…" />
            <button type="submit" className="op-btn op-btn-primary" disabled={busy || !noteText.trim()}>Add</button>
          </form>
          {(notes || []).length === 0 ? (
            <div className="op-muted">No notes yet.</div>
          ) : (
            <ul className="op-note-list">
              {notes.map((n) => (
                <li key={n.id}>
                  <span className="op-note-body">{n.body}</span>
                  <span className="op-note-meta">{n.author_name || '—'} · {formatPkt(n.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {orders.length > 1 && (
          <section className="op-notes">
            <h4>Previous orders</h4>
            {orders.map((o) => (
              <button key={o.id} type="button" className={`op-history ${o.id === order?.id ? 'is-current' : ''}`} onClick={() => setActiveId(o.id)}>
                <span>{o.order_number}</span>
                <span className={`op-stage op-stage-${o.stage}`}>{STAGE_LABELS[o.stage]}</span>
                <span className="op-muted">{formatPkt(o.order_created_at)}</span>
              </button>
            ))}
          </section>
        )}
      </div>
    </aside>
  )
}
