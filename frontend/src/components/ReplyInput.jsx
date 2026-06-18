import { useRef, useState, useEffect } from 'react'
import { sendMessage } from '../utils/api'
import './ReplyInput.css'

export default function ReplyInput({ conversation }) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    setMessage('')
    setError(null)
  }, [conversation?.id])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [message])

  async function handleSendMessage(e) {
    e?.preventDefault?.()
    const text = message.trim()
    if (!text || sending) return

    setSending(true)
    setError(null)

    try {
      await sendMessage(conversation.phone, text, conversation.id)
      setMessage('')
    } catch (err) {
      console.error('Failed to send message:', err)
      setError(err.response?.data?.error || 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e) => {
    // Enter inserts a newline (textarea default). Ctrl/Cmd+Enter sends —
    // a power-user shortcut so you don't have to reach for the mouse.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSendMessage(e)
    }
  }

  const hasText = message.trim().length > 0

  return (
    <div className="ri-wrap">
      {error && (
        <div className="ri-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <form className="ri-form" onSubmit={handleSendMessage}>
        <button type="button" className="ri-icon" aria-label="Emoji" tabIndex={-1}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10S22 17.52 22 12 17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
          </svg>
        </button>

        <button type="button" className="ri-icon ri-attach" aria-label="Attach" tabIndex={-1}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M16.5 6.5v10.79a4.71 4.71 0 0 1-4.5 4.71A4.71 4.71 0 0 1 7.5 17.29V6.71a3.71 3.71 0 0 1 7.42 0v9.79a2.71 2.71 0 0 1-5.42 0V8h1.5v8.5a1.21 1.21 0 0 0 2.42 0V6.71a2.21 2.21 0 0 0-4.42 0v10.58a3.21 3.21 0 0 0 6.42 0V6.5h1.58z" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message"
          disabled={sending}
          className="ri-textarea"
          rows={1}
        />

        <button
          type="submit"
          className={`ri-send ${hasText || sending ? 'is-send' : 'is-mic'}`}
          disabled={(!hasText && !sending) ? false : sending}
          aria-label={hasText ? 'Send' : 'Voice message'}
          onClick={(e) => {
            if (!hasText) {
              e.preventDefault()
            }
          }}
        >
          {sending ? (
            <svg viewBox="0 0 24 24" width="22" height="22" className="ri-spin">
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeWidth="2.5"
                fill="none"
                strokeDasharray="40 18"
                strokeLinecap="round"
              />
            </svg>
          ) : hasText ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
            </svg>
          )}
        </button>
      </form>
    </div>
  )
}
