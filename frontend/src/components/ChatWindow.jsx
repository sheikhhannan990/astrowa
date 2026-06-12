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

        <div className="cw-header-actions" aria-hidden>
          <button className="cw-icon-btn" title="Search">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99 1.49-1.49-4.99-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
            </svg>
          </button>
          <button className="cw-icon-btn" title="Menu">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>
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
