// Shared order-workflow helpers: Pakistan time, labels, quick-reply
// variables and the rule-based reply suggestions.

export const PKT_OFFSET_MS = 5 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// Start of "today" in Pakistan time, as a Date — regardless of the
// device's own timezone.
export function startOfTodayPKT(now = Date.now()) {
  return new Date(Math.floor((now + PKT_OFFSET_MS) / DAY_MS) * DAY_MS - PKT_OFFSET_MS)
}

export function pktHour(now = Date.now()) {
  return new Date(now + PKT_OFFSET_MS).getUTCHours()
}

// "2026-11-26T19:00" in PKT → ISO string with +05:00, for <input type=datetime-local>.
export function pktLocalInputToISO(value) {
  return value ? `${value}:00+05:00` : null
}

export function isoToPktLocalInput(date) {
  const d = new Date(date.getTime() + PKT_OFFSET_MS)
  return d.toISOString().slice(0, 16)
}

export function formatPkt(iso, opts = {}) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    day: opts.noDate ? undefined : '2-digit',
    month: opts.noDate ? undefined : 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

// "4m", "2h 10m", "3d"
export function formatAge(fromIso, now = Date.now()) {
  if (!fromIso) return ''
  const mins = Math.max(0, Math.round((now - Date.parse(fromIso)) / 60000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

// Hours left in WhatsApp's free 24h reply window (null = closed / unknown).
export function windowHoursLeft(lastCustomerMessageAt, now = Date.now()) {
  if (!lastCustomerMessageAt) return null
  const left = Date.parse(lastCustomerMessageAt) + DAY_MS - now
  return left > 0 ? left / 3600000 : null
}

export const STAGE_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  shipped: 'Shipped',
  delivered: 'Delivered',
  returned: 'Returned',
}

export const FLAG_LABELS = {
  not_on_whatsapp: 'Not on WhatsApp',
  address_incomplete: 'Address incomplete',
  village_address: 'Village address',
  no_city: 'City missing',
  invalid_phone: 'Invalid phone',
  address_issue: 'Address issue raised',
  cancel_requested: 'Cancellation asked',
  payment_pending: 'Payment pending',
  unreachable: 'Unreachable',
  wrong_number: 'Wrong number',
  whatsapp_failed: 'WhatsApp send failed',
  refused_before: 'Refused before',
}

export const CALL_OUTCOMES = [
  { id: 'confirmed', label: 'Confirmed', tone: 'good' },
  { id: 'no_answer', label: 'No answer', tone: 'warn' },
  { id: 'busy', label: 'Busy / off', tone: 'warn' },
  { id: 'call_back', label: 'Call back at…', tone: 'neutral' },
  { id: 'address_corrected', label: 'Address corrected', tone: 'neutral' },
  { id: 'wrong_number', label: 'Wrong number', tone: 'bad' },
  { id: 'cancelled', label: 'Cancelled', tone: 'bad' },
]

export const DEFAULT_CANCEL_REASONS = [
  'Changed mind', 'Ordered by mistake', 'Price / budget', 'Delivery time too long',
  'Ordered elsewhere', 'Fake / prank order', 'Duplicate order', 'Unreachable',
  'Refused advance payment', 'Other',
]

export const CANCEL_REASON_QUESTION = 'Can you please share reason for cancellation?'

const DEFAULT_DELIVERY = [
  { days: '1-2', cities: ['lahore'] },
  { days: '2-3', cities: ['karachi', 'islamabad', 'rawalpindi', 'faisalabad', 'multan', 'gujranwala',
    'sialkot', 'peshawar', 'hyderabad', 'sargodha', 'bahawalpur', 'sheikhupura'] },
]

export function deliveryDays(city, config) {
  const table = config?.delivery_days || DEFAULT_DELIVERY
  const c = (city || '').toLowerCase()
  const hit = table.find((row) => row.cities.some((name) => c.includes(name)))
  return hit ? hit.days : config?.default_delivery_days || '3-4'
}

export function phoneForDialing(phone) {
  return phone ? `+${phone}` : ''
}

export function firstName(name) {
  const n = (name || '').trim().split(/\s+/)[0]
  return n && n.toLowerCase() !== 'customer' ? n : ''
}

// Fill {name} {order} {total} {days} {city} {tracking} in quick replies.
export function fillVariables(text, { conversation, order, config }) {
  const city = order?.city || conversation?.shipping_address?.city || ''
  const values = {
    name: firstName(order?.customer_name || conversation?.customer_name),
    order: order?.order_number || conversation?.order_id || '',
    total: order?.total ? `Rs. ${Math.round(order.total).toLocaleString('en-PK')}` : '',
    days: deliveryDays(city, config),
    city,
    tracking: order?.tracking_number || conversation?.tracking_number || '',
  }
  return text
    .replace(/\{(name|order|total|days|city|tracking)\}/g, (_, key) => values[key] || '')
    .replace(/^(Hi|Hello|Dear)\s+,/m, '$1,')
}

// ---------- Notes ----------

// One-tap notes for the most common outcomes; anything else can be typed.
export const NOTE_PRESETS = [
  "Didn't pick call",
  "Didn't respond",
  'Call back later',
  'Confirmed on call',
  'Address confirmed',
  'Will pay advance',
  'Wrong number',
  'Wants to cancel',
]

// ---------- Suggested replies ----------
// Like Instagram's suggested replies: based on the order and what the
// customer just said, suggest the quick reply you'd normally send.
// Patterns come from your past chats.

const TOPICS = [
  ['ack', /^(ok+|okay|okk+|oky|okok|ok sir|sure|alright|perfect|done|thanks?|thank ?you|thankyou|ty|jazak\S*|👍\S*|great|nice|good|fine|theek|thik|acha|jee|ji)\W{0,3}( ?(thanks?|thank ?you|thankyou|sir|bhai|g|ji|jee))?\W{0,3}$/],
  ['cancel', /cancel|nahi chahiye|nhi chahiye|don'?t want|not want|wapis/],
  ['payment', /payment|paid|\bpay\b|bank|transfer|easypaisa|jazzcash|iban|screenshot|advance|account/],
  ['damage', /broken|damage|crack|not working|kharab|toot|tut gay|defect|replace|refund|warranty/],
  ['delivery', /when|kab|kb\b|tak\b|tk\b|deliver|parcel|receive|rider|dispatch|track|courier|reach|poncha|puhanch|pohanch|mil ja|kitne din|days|today|tomorrow|\bkal\b|abhi tak|still|yet|where|update/],
]

export function topicOf(text) {
  const t = (text || '').trim().toLowerCase()
  if (!t) return null
  for (const [name, rx] of TOPICS) if (rx.test(t)) return name
  return null
}

const findReply = (replies, rx) => replies.find((q) => rx.test(q.title || ''))

// Returns [{ id, label, reply? (quick reply), text?, action? }].
export function suggestReplies({ lastIncoming, order, conversation, quickReplies = [] }) {
  const out = []
  const add = (reply, label) => {
    if (reply && !out.some((s) => s.reply?.id === reply.id)) out.push({ id: reply.id, label: label || reply.title, reply })
  }
  const stage = order?.stage
  const flags = order?.flags || []
  const open = !order || stage === 'pending'
  const isBank = order?.payment_method === 'bank' || conversation?.last_template === 'bank_pending'
  const topic = lastIncoming?.type === 'text' ? topicOf(lastIncoming.body) : null
  const sentPicture = lastIncoming && ['image', 'document'].includes(lastIncoming.type)

  // Order still open: the checks you'd do before dispatching.
  if (open && flags.includes('refused_before')) add(findReply(quickReplies, /advance|refus/i), 'Refused before → ask PKR 200')
  if (open && flags.includes('village_address')) add(findReply(quickReplies, /village/i))
  if (open && flags.includes('address_incomplete')) add(findReply(quickReplies, /incomplete/i))
  if (open && isBank && sentPicture) out.unshift({ id: 'paid', label: 'Mark paid & notify', action: 'mark_paid' })
  if (open && isBank && topic === 'payment' && !sentPicture) add(findReply(quickReplies, /bank details/i))

  // Whatever the stage, answer what the customer asked.
  if (topic === 'cancel' && stage !== 'cancelled') add(findReply(quickReplies, /reason/i))
  if (topic === 'damage') out.push({ id: 'video', label: 'Ask for video', text: 'Can you please share a video of the issue with us?' })
  if (topic === 'delivery' && stage === 'shipped' && order?.tracking_number) {
    out.push({ id: 'track', label: 'Send tracking', text:
      `Your order has been dispatched. You can track it here: https://postex.pk/tracking?cn=${order.tracking_number}` })
  }
  return out.slice(0, 4)
}
