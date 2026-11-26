import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchPaged } from '../utils/supabaseClient'
import { orderAction, errorText } from '../utils/api'
import ChatWindow from '../components/ChatWindow'
import {
  FLAG_LABELS, STAGE_LABELS, formatPkt, rangeFor, pktDateInput, startOfTodayPKT,
  whatsappLink, phoneForDialing,
} from '../utils/workflow'
import './views.css'

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Last 7 days' },
  { id: 'month', label: 'Last 30 days' },
  { id: 'custom', label: 'Pick dates' },
]
const LOADED_DAYS = 31
// Groups in the order they're shown: what needs action first.
const GROUPS = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned']
const WARNINGS = ['refused_before', 'not_on_whatsapp', 'village_address', 'address_incomplete', 'invalid_phone', 'wrong_number']

// Orders page: every order in a date range, grouped by status, with the
// notes written on each — so it's easy to see what was followed up.
// Clicking an order opens its chat right here (beside the list on a
// computer, full screen on a phone) instead of jumping to the Inbox.
export default function Today({ data, onOrderUpdated, isMobileView, onChatOpenChange }) {
  const { orders: liveOrders, conversations, config, loading, error, patchConversation } = data
  const [selected, setSelected] = useState(null) // { conversationId, orderId }
  const [fetchedConv, setFetchedConv] = useState(null)
  const [range, setRange] = useState('today')
  const [custom, setCustom] = useState(() => ({ from: pktDateInput(Date.now()), to: pktDateInput(Date.now()) }))
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [olderOrders, setOlderOrders] = useState(null) // for ranges before the loaded month
  const [notes, setNotes] = useState([])
  const [actionError, setActionError] = useState(null)

  const [from, to] = rangeFor(range, custom)
  const loadedSince = startOfTodayPKT().getTime() - (LOADED_DAYS - 1) * 86400000
  const needsFetch = from < loadedSince

  // Orders older than the live month are fetched on demand.
  useEffect(() => {
    if (!needsFetch) { setOlderOrders(null); return }
    let cancelled = false
    fetchPaged((a, b) => supabase.from('orders').select('*')
      .gte('order_created_at', new Date(from).toISOString())
      .lt('order_created_at', new Date(to).toISOString())
      .order('order_created_at', { ascending: false }).range(a, b), 5000)
      .then((rows) => { if (!cancelled) setOlderOrders(rows) })
      .catch(() => { if (!cancelled) setOlderOrders([]) })
    return () => { cancelled = true }
  }, [needsFetch, from, to])

  // Notes written since the range started (notes come after the order).
  useEffect(() => {
    let cancelled = false
    const load = () => fetchPaged((a, b) => supabase.from('notes').select('*')
      .gte('created_at', new Date(from).toISOString())
      .order('created_at', { ascending: true }).range(a, b), 5000)
      .then((rows) => { if (!cancelled) setNotes(rows) })
      .catch(() => {})
    load()
    const channel = supabase.channel(`orders-notes-${from}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes' },
        (p) => setNotes((prev) => (prev.some((n) => n.id === p.new.id) ? prev : [...prev, p.new])))
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [from])

  const convById = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations])

  const onOpen = (conversationId, orderId) => setSelected({ conversationId, orderId })
  const closeChat = () => setSelected(null)

  useEffect(() => {
    onChatOpenChange?.(!!selected)
  }, [selected, onChatOpenChange])
  useEffect(() => () => onChatOpenChange?.(false), [onChatOpenChange])

  // The inbox list holds the most recent chats; older ones are fetched.
  const liveConv = selected ? convById.get(selected.conversationId) : null
  useEffect(() => {
    if (!selected || liveConv) { setFetchedConv(null); return }
    let cancelled = false
    supabase.from('conversations').select('*').eq('id', selected.conversationId).maybeSingle()
      .then(({ data: row }) => { if (!cancelled) setFetchedConv(row || null) })
    return () => { cancelled = true }
  }, [selected, liveConv])
  const selectedConv = liveConv || (fetchedConv?.id === selected?.conversationId ? fetchedConv : null)

  const chatOrders = useMemo(() => {
    if (!selectedConv) return []
    const all = [...liveOrders, ...(olderOrders || [])]
    const seen = new Set()
    return all
      .filter((o) => (o.conversation_id === selectedConv.id || o.phone === selectedConv.phone) && !seen.has(o.id) && seen.add(o.id))
      .sort((a, b) => Date.parse(b.order_created_at) - Date.parse(a.order_created_at))
  }, [liveOrders, olderOrders, selectedConv])

  useEffect(() => {
    if (!selected) return
    const onKey = (e) => { if (e.key === 'Escape') closeChat() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const inRange = useMemo(() => {
    const source = needsFetch ? (olderOrders || []) : liveOrders
    return source.filter((o) => {
      const t = Date.parse(o.order_created_at)
      return t >= from && t < to
    })
  }, [needsFetch, olderOrders, liveOrders, from, to])

  const notesByOrder = useMemo(() => {
    const byOrder = new Map()
    const byConv = new Map()
    for (const n of notes) {
      if (n.order_id) byOrder.set(n.order_id, [...(byOrder.get(n.order_id) || []), n])
      else if (n.conversation_id) byConv.set(n.conversation_id, [...(byConv.get(n.conversation_id) || []), n])
    }
    const get = (o) => [...(byOrder.get(o.id) || []), ...(byConv.get(o.conversation_id) || [])
      .filter((n) => Date.parse(n.created_at) >= Date.parse(o.order_created_at))]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    return get
  }, [notes])

  const counts = useMemo(() => {
    const c = { all: inRange.length, important: 0, notwa: 0, unchecked: 0 }
    for (const g of GROUPS) c[g] = 0
    for (const o of inRange) {
      c[o.stage] = (c[o.stage] || 0) + 1
      if ((o.flags || []).includes('important')) c.important += 1
      if ((o.flags || []).includes('not_on_whatsapp') && o.stage === 'pending') c.notwa += 1
      if (o.stage === 'pending' && notesByOrder(o).length === 0) c.unchecked += 1
    }
    return c
  }, [inRange, notesByOrder])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inRange.filter((o) => {
      if (filter === 'important' && !(o.flags || []).includes('important')) return false
      if (filter === 'notwa' && !((o.flags || []).includes('not_on_whatsapp') && o.stage === 'pending')) return false
      if (filter === 'unchecked' && !(o.stage === 'pending' && notesByOrder(o).length === 0)) return false
      if (GROUPS.includes(filter) && o.stage !== filter) return false
      if (!q) return true
      const name = (o.customer_name || convById.get(o.conversation_id)?.customer_name || '').toLowerCase()
      return name.includes(q) || (o.phone || '').includes(q) || (o.order_number || '').toLowerCase().includes(q)
    })
  }, [inRange, filter, search, notesByOrder, convById])

  const groups = GROUPS.map((g) => ({
    stage: g,
    orders: shown.filter((o) => o.stage === g).sort((a, b) =>
      g === 'pending' ? Date.parse(a.order_created_at) - Date.parse(b.order_created_at)
        : Date.parse(b.order_created_at) - Date.parse(a.order_created_at)),
  })).filter((g) => g.orders.length)

  async function toggleImportant(order) {
    setActionError(null)
    try {
      const res = await orderAction(order.id, 'important', { value: !(order.flags || []).includes('important') })
      if (res.order) {
        onOrderUpdated?.(res.order)
        if (olderOrders) setOlderOrders((prev) => prev.map((o) => (o.id === res.order.id ? res.order : o)))
      }
    } catch (err) {
      setActionError(errorText(err))
    }
  }

  const tiles = [
    { id: 'all', label: 'All orders', tone: 'neutral' },
    { id: 'pending', label: 'Pending', tone: 'warn' },
    { id: 'unchecked', label: 'Pending, no notes', tone: 'bad', hint: 'not followed up yet' },
    { id: 'confirmed', label: 'Confirmed', tone: 'good' },
    { id: 'shipped', label: 'Shipped', tone: 'blue' },
    { id: 'cancelled', label: 'Cancelled', tone: 'bad' },
    { id: 'important', label: '⭐ Important', tone: 'star' },
    { id: 'notwa', label: 'Not on WhatsApp', tone: 'warn' },
  ]
  if (counts.returned) tiles.splice(6, 0, { id: 'returned', label: 'Returned', tone: 'bad' })

  const chat = selected && (
    <div className={`orders-chat ${isMobileView ? 'is-mobile' : ''}`}>
      {selectedConv ? (
        <ChatWindow
          key={selectedConv.id}
          conversation={selectedConv}
          orders={chatOrders}
          config={config}
          focusOrderId={selected.orderId}
          defaultShowOrder={isMobileView ? false : window.innerWidth >= 1500}
          onOrderUpdated={onOrderUpdated}
          onConversationUpdate={(id) => patchConversation(id, { unread_count: 0 })}
          onBack={closeChat}
          isMobile={isMobileView}
        />
      ) : (
        <div className="td-empty">Loading chat…</div>
      )}
    </div>
  )

  // Phone: the chat takes the whole screen; back returns to the list.
  if (isMobileView && chat) return chat

  return (
    <div className={`orders-layout ${chat ? 'has-chat' : ''}`}>
    <div className="today orders-page">
      <div className="td-top">
        <div>
          <h1>Orders</h1>
          <div className="td-sub">
            {range === 'custom' ? `${custom.from} → ${custom.to}` : RANGES.find((r) => r.id === range)?.label}
            {' · '}{counts.all} order{counts.all === 1 ? '' : 's'}
          </div>
        </div>
        <div className="op-range">
          {RANGES.map((r) => (
            <button key={r.id} type="button" className={`td-pill ${range === r.id ? 'is-active' : ''}`} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {range === 'custom' && (
        <div className="op-custom">
          <label>From <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label>To <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
        </div>
      )}

      {(error || actionError) && <div className="td-error">{error || actionError}</div>}

      <div className="td-kpis">
        {tiles.map((t) => (
          <button key={t.id} type="button" className={`td-kpi td-tone-${t.tone} ${filter === t.id ? 'is-selected' : ''}`} onClick={() => setFilter(t.id)}>
            <span className="td-kpi-value">{counts[t.id] || 0}</span>
            <span className="td-kpi-label">{t.label}</span>
            {t.hint && <span className="td-kpi-hint">{t.hint}</span>}
          </button>
        ))}
      </div>

      <input className="op-search" type="search" placeholder="Search name, phone or order number" value={search} onChange={(e) => setSearch(e.target.value)} />

      {(loading && !liveOrders.length) || (needsFetch && olderOrders === null) ? (
        <div className="td-empty">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="td-card"><div className="td-empty">No orders here.</div></div>
      ) : (
        groups.map((g) => (
          <section key={g.stage} className="td-card">
            <header className="td-card-head">
              <span className={`td-stage td-stage-${g.stage}`}>{STAGE_LABELS[g.stage]}</span>
              <span className="td-count">{g.orders.length}</span>
            </header>
            <div className="ol-rows">
              {g.orders.map((o) => (
                <OrderRow key={o.id} order={o} conv={convById.get(o.conversation_id)} notes={notesByOrder(o)}
                  onOpen={onOpen} onStar={toggleImportant} isOpen={selected?.orderId === o.id} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
    {chat}
    </div>
  )
}

function OrderRow({ order, conv, notes, onOpen, onStar, isOpen }) {
  const flags = order.flags || []
  const important = flags.includes('important')
  const warnings = flags.filter((f) => WARNINGS.includes(f))
  const name = order.customer_name || conv?.customer_name || 'Customer'
  const open = () => order.conversation_id && onOpen(order.conversation_id, order.id)
  return (
    <div className={`ol-row ${important ? 'is-important' : ''} ${isOpen ? 'is-open' : ''}`}>
      <button type="button" className={`ol-star ${important ? 'is-on' : ''}`} onClick={() => onStar(order)}
        title={important ? 'Remove from important' : 'Mark as important — revisit this order'} aria-pressed={important}>
        {important ? '★' : '☆'}
      </button>
      <div className="ol-main" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
        <div className="ol-line1">
          <span className="td-name">{name}</span>
          <span className="td-order">{order.order_number}</span>
          {order.payment_method === 'bank' && <span className="td-flag td-flag-bank">Bank</span>}
          <span className="ol-spacer" />
          <span className="ol-amount">Rs. {Math.round(order.total || 0).toLocaleString('en-PK')}</span>
        </div>
        <div className="ol-line2">
          {[order.city, formatPkt(order.order_created_at), order.items_text].filter(Boolean).join(' · ')}
        </div>
        {(warnings.length > 0 || order.cancel_reason) && (
          <div className="td-flags">
            {warnings.map((f) => <span key={f} className={`td-flag td-flag-${f}`}>{FLAG_LABELS[f]}</span>)}
            {order.stage === 'cancelled' && order.cancel_reason && <span className="td-flag">Reason: {order.cancel_reason}</span>}
          </div>
        )}
        {notes.length > 0 ? (
          <ul className="ol-notes">
            {notes.map((n) => (
              <li key={n.id}>📝 {n.body} <span className="td-small">— {n.author_name || '—'}, {formatPkt(n.created_at)}</span></li>
            ))}
          </ul>
        ) : order.stage === 'pending' ? (
          <div className="ol-nonotes">No notes yet — not followed up</div>
        ) : null}
      </div>
      <div className="ol-actions">
        <button type="button" className="td-btn" onClick={open} disabled={!order.conversation_id}>Open chat</button>
        <a className="td-btn ol-wa" href={whatsappLink(order.phone)} target="_blank" rel="noreferrer" title="Open in your other WhatsApp — free follow-up">💬 WhatsApp</a>
        <a className="td-btn" href={`tel:${phoneForDialing(order.phone)}`}>📞</a>
      </div>
    </div>
  )
}
