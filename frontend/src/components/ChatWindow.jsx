import { useState, useEffect, useRef } from 'react'
import { supabase } from '../utils/supabaseClient'
import MessageBubbles from './MessageBubbles'
import ReplyInput from './ReplyInput'
import './ChatWindow.css'

function formatPhone(phone) {
  if (!phone) return ''
  return phone.replace(/(\d{2})(\d{3})(\d{7})/, '+$1 $2 $3')
}

export default function ChatWindow({ conversation, onBack, onConversationUpdate, isMobile }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const messagesEndRef = useRef(null)
  const scrollRef = useRef(null)

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
          {conversation.tracking_number && (
            <a
              href={`https://postex.pk/tracking?cn=${encodeURIComponent(conversation.tracking_number)}`}
              target="_blank"
              rel="noreferrer"
              className="cw-track-btn"
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
