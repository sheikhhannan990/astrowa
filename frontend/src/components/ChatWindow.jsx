import { useState, useEffect, useRef } from 'react'
import { supabase } from '../utils/supabaseClient'
import MessageBubbles from './MessageBubbles'
import ReplyInput from './ReplyInput'
import './ChatWindow.css'

function formatPhone(phone) {
  if (!phone) return ''
  return phone.replace(/(\d{2})(\d{3})(\d{7})/, '+$1 $2 $3')
}

// Formats the address dict from Supabase (a compact subset of Shopify's
// shipping_address) into a multi-line string for the dropdown + clipboard.
function formatAddress(addr) {
  if (!addr || typeof addr !== 'object') return ''
  const cityLine = [addr.city, addr.province, addr.zip].filter(Boolean).join(', ')
  return [
    addr.name,
    addr.company,
    addr.address1,
    addr.address2,
    cityLine,
    addr.country,
    addr.phone,
  ]
    .filter(Boolean)
    .join('\n')
}

export default function ChatWindow({ conversation, onBack, onConversationUpdate, isMobile }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showAddress, setShowAddress] = useState(false)
  const [addressCopied, setAddressCopied] = useState(false)
  const messagesEndRef = useRef(null)
  const scrollRef = useRef(null)
  const addressBtnRef = useRef(null)
  const addressPanelRef = useRef(null)

  useEffect(() => {
    if (!conversation?.id) return

    fetchMessages()
    markConversationAsRead()

    const subscription = supabase
      .channel(`messages_${conversation.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setMessages((prev) => {
              if (prev.some((m) => m.id === payload.new.id)) return prev
              return [...prev, payload.new]
            })
          } else if (payload.eventType === 'UPDATE') {
            setMessages((prev) =>
              prev.map((m) => (m.id === payload.new.id ? payload.new : m))
            )
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(subscription)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length])

  // Close the Address dropdown when navigating to another chat, clicking
  // outside it, or pressing Escape — same pattern as the tag dropdown.
  useEffect(() => {
    setShowAddress(false)
    setAddressCopied(false)
  }, [conversation?.id])

  useEffect(() => {
    if (!showAddress) return
    const onDocClick = (e) => {
      if (
        addressPanelRef.current?.contains(e.target) ||
        addressBtnRef.current?.contains(e.target)
      ) {
        return
      }
      setShowAddress(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setShowAddress(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [showAddress])

  async function fetchMessages() {
    try {
      setLoading(true)
      const { data, error: err } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })

      if (err) throw err

      setMessages(data || [])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch messages:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function markConversationAsRead() {
    // Only update if we have unread messages, to avoid unnecessary
    // realtime echoes when the user opens a chat that is already read.
    if (!conversation?.unread_count || conversation.unread_count === 0) return

    try {
      const { error: err } = await supabase
        .from('conversations')
        .update({ unread_count: 0 })
        .eq('id', conversation.id)

      if (err) throw err

      onConversationUpdate?.()
    } catch (err) {
      console.error('Failed to mark conversation as read:', err)
    }
  }

  const initial = (conversation.customer_name || 'C')[0].toUpperCase()
  const shippingAddress = conversation.shipping_address
  const hasAddress = !!(
    shippingAddress &&
    typeof shippingAddress === 'object' &&
    Object.keys(shippingAddress).length > 0
  )
  const addressText = hasAddress ? formatAddress(shippingAddress) : ''

  async function copyAddress() {
    if (!addressText) return
    try {
      await navigator.clipboard.writeText(addressText)
      setAddressCopied(true)
      setTimeout(() => setAddressCopied(false), 1500)
    } catch {
      setAddressCopied(false)
    }
  }

  return (
    <div className={`chat-window ${isMobile ? 'is-mobile' : ''}`}>
      <header className="cw-header">
        {onBack && (
          <button className="cw-back" onClick={onBack} aria-label="Back">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
          </button>
        )}

        <div className="cw-header-avatar" aria-hidden>
          {initial}
        </div>

        <div className="cw-header-info">
          <div className="cw-header-name truncate">
            {conversation.customer_name || 'Unknown'}
          </div>
          <div className="cw-header-meta truncate">
            <span className="cw-phone">{formatPhone(conversation.phone)}</span>
            {conversation.order_id && (
              <>
                <span className="cw-dot" aria-hidden>·</span>
                <span className="cw-order">Order {conversation.order_id}</span>
              </>
            )}
          </div>
        </div>

        <div className="cw-header-actions">
          {hasAddress && (
            <div className="cw-action-wrap">
              <button
                ref={addressBtnRef}
                type="button"
                className={`cw-header-pill cw-address-btn ${showAddress ? 'is-open' : ''}`}
                onClick={() => setShowAddress((v) => !v)}
                aria-expanded={showAddress}
                aria-haspopup="dialog"
                title="View shipping address"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
                </svg>
                <span>Address</span>
                <svg
                  viewBox="0 0 12 12"
                  width="10"
                  height="10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="cw-pill-caret"
                  aria-hidden
                >
                  <path d="M3 4.5l3 3 3-3" />
                </svg>
              </button>
              {showAddress && (
                <div
                  ref={addressPanelRef}
                  className="cw-address-panel"
                  role="dialog"
                  aria-label="Shipping address"
                >
                  <div className="cw-address-panel-head">
                    <span className="cw-address-panel-title">Shipping address</span>
                    <button
                      type="button"
                      className="cw-address-copy"
                      onClick={copyAddress}
                      aria-label="Copy address"
                    >
                      {addressCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="cw-address-body">
                    {shippingAddress.name && (
                      <div className="cw-address-line cw-address-name">
                        {shippingAddress.name}
                      </div>
                    )}
                    {shippingAddress.company && (
                      <div className="cw-address-line">{shippingAddress.company}</div>
                    )}
                    {shippingAddress.address1 && (
                      <div className="cw-address-line">{shippingAddress.address1}</div>
                    )}
                    {shippingAddress.address2 && (
                      <div className="cw-address-line">{shippingAddress.address2}</div>
                    )}
                    {(shippingAddress.city || shippingAddress.province || shippingAddress.zip) && (
                      <div className="cw-address-line">
                        {[shippingAddress.city, shippingAddress.province, shippingAddress.zip]
                          .filter(Boolean)
                          .join(', ')}
                      </div>
                    )}
                    {shippingAddress.country && (
                      <div className="cw-address-line">{shippingAddress.country}</div>
                    )}
                    {shippingAddress.phone && (
                      <div className="cw-address-line cw-address-muted">
                        {shippingAddress.phone}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {conversation.tracking_number && (
            <a
              href={`https://postex.pk/tracking?cn=${encodeURIComponent(conversation.tracking_number)}`}
              target="_blank"
              rel="noreferrer"
              className="cw-header-pill cw-track-btn"
              title={`Track on Postex (${conversation.tracking_number})`}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                <path d="M20 8h-3V4H3c-1.11 0-2 .89-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm12 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm-1-5.5V9.5h2.5L21.46 13H17z" />
              </svg>
              <span>Track</span>
            </a>
          )}
        </div>
      </header>

      <div className="cw-messages" ref={scrollRef}>
        {loading ? (
          <div className="cw-status">Loading messages...</div>
        ) : error ? (
          <div className="cw-status cw-status-error">Error: {error}</div>
        ) : messages.length === 0 ? (
          <div className="cw-status">
            No messages yet. Send a message to start the conversation.
          </div>
        ) : (
          <>
            <MessageBubbles messages={messages} />
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <ReplyInput conversation={conversation} />
    </div>
  )
}
