import { Fragment } from 'react'
import './MessageBubbles.css'

function formatTime(dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function dateKey(dateString) {
  if (!dateString) return ''
  const d = new Date(dateString)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dateLabel(dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((today - that) / 86400000)

  if (diffDays === 0) return 'TODAY'
  if (diffDays === 1) return 'YESTERDAY'
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  }
  return date
    .toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' })
    .toUpperCase()
}

const STATUS_LABEL = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  receiving: 'Sending',
}

// WhatsApp-style status ticks rendered as inline SVGs so they look crisp.
function StatusTicks({ status }) {
  if (!status) return null

  if (status === 'failed') {
    return (
      <span className="mb-status mb-status-failed" title="Failed">
        <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden>
          <path
            d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1zm0 9a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm-.5-6h1v3h-1V4zm0 4h1v1h-1V8z"
            fill="currentColor"
          />
        </svg>
      </span>
    )
  }

  if (status === 'sending' || status === 'receiving') {
    return (
      <span className="mb-status mb-status-sending" title="Sending">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M8 1.5A6.5 6.5 0 1 1 1.5 8 6.5 6.5 0 0 1 8 1.5zm0 1A5.5 5.5 0 1 0 13.5 8 5.5 5.5 0 0 0 8 2.5zM8 4v4l3 1.5"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
        </svg>
      </span>
    )
  }

  // single tick for "sent"
  if (status === 'sent') {
    return (
      <span className="mb-status" title="Sent">
        <svg viewBox="0 0 16 11" width="16" height="11" aria-hidden>
          <path
            d="M11.071.653a.5.5 0 0 1 .124.696l-7 9.5a.5.5 0 0 1-.74.072l-3-3a.5.5 0 1 1 .707-.707l2.591 2.59L10.376.777a.5.5 0 0 1 .695-.124z"
            fill="currentColor"
          />
        </svg>
      </span>
    )
  }

  // double tick for delivered / read
  const isRead = status === 'read'
  return (
    <span
      className={`mb-status ${isRead ? 'mb-status-read' : ''}`}
      title={isRead ? 'Read' : 'Delivered'}
    >
      <svg viewBox="0 0 16 11" width="16" height="11" aria-hidden>
        <path
          d="M11.071.653a.5.5 0 0 1 .124.696l-7 9.5a.5.5 0 0 1-.74.072l-3-3a.5.5 0 1 1 .707-.707l2.591 2.59L10.376.777a.5.5 0 0 1 .695-.124z"
          fill="currentColor"
        />
        <path
          d="M15.071.653a.5.5 0 0 1 .124.696l-7 9.5a.5.5 0 0 1-.74.072l-1.155-1.155 1.062-1.443 1.014 1.013L14.376.777a.5.5 0 0 1 .695-.124z"
          fill="currentColor"
        />
      </svg>
    </span>
  )
}

function renderMessageText(text) {
  if (!text) return null
  const lines = text.split('\n')
  return lines.map((line, idx) => (
    <Fragment key={idx}>
      {idx > 0 && <br />}
      {line}
    </Fragment>
  ))
}

// Heuristic: caption text we want to show next to a media attachment.
// The backend stores a placeholder like '📷 Image' when there's no real
// caption — skip those so we don't double-render an empty label.
function realCaption(body) {
  if (!body) return ''
  const trimmed = body.trim()
  const placeholders = [
    '📷 Image',
    '🎤 Voice note',
    '🎬 Video',
    '📎 Document',
    '🌟 Sticker',
    '📎 Attachment',
  ]
  return placeholders.includes(trimmed) ? '' : trimmed
}

function renderMessageBody(message) {
  // Reactions get a big-emoji rendering so they read as a reaction, not a text.
  if (message.type === 'reaction') {
    return (
      <div className="mb-reaction-block">
        <span className="mb-reaction-label">Reacted</span>
        <span className="mb-reaction-emoji">{message.body || '❌'}</span>
      </div>
    )
  }

  const url = message.media_url
  const mime = (message.media_mime_type || '').toLowerCase()

  if (url) {
    if (mime.startsWith('image/')) {
      const caption = realCaption(message.body)
      return (
        <div className="mb-media">
          <a href={url} target="_blank" rel="noreferrer" className="mb-media-link">
            <img src={url} alt={caption || 'image'} className="mb-image" loading="lazy" />
          </a>
          {caption && <div className="mb-caption">{renderMessageText(caption)}</div>}
        </div>
      )
    }
    if (mime.startsWith('audio/')) {
      return (
        <div className="mb-media">
          <audio controls preload="metadata" src={url} className="mb-audio" />
        </div>
      )
    }
    if (mime.startsWith('video/')) {
      const caption = realCaption(message.body)
      return (
        <div className="mb-media">
          <video controls preload="metadata" src={url} className="mb-video" />
          {caption && <div className="mb-caption">{renderMessageText(caption)}</div>}
        </div>
      )
    }
    // Documents and anything else — fall back to a download chip.
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mb-attachment">
        <span className="mb-attachment-icon" aria-hidden>📎</span>
        <span className="mb-attachment-label">{realCaption(message.body) || 'Download attachment'}</span>
      </a>
    )
  }

  return <div className="mb-text">{renderMessageText(message.body)}</div>
}

export default function MessageBubbles({ messages }) {
  let lastDateKey = null
  let lastDirection = null

  return (
    <div className="mb-list">
      {messages.map((message) => {
        const isOutgoing = message.direction === 'outgoing'
        const currentKey = dateKey(message.created_at)
        const showDate = currentKey !== lastDateKey
        const isFirstOfGroup = showDate || lastDirection !== message.direction
        lastDateKey = currentKey
        lastDirection = message.direction

        const hasMedia = !!message.media_url
        const isReaction = message.type === 'reaction'

        return (
          <Fragment key={message.id}>
            {showDate && (
              <div className="mb-date-divider">
                <span>{dateLabel(message.created_at)}</span>
              </div>
            )}

            <div className={`mb-row ${isOutgoing ? 'out' : 'in'}`}>
              <div
                className={`mb-bubble ${isOutgoing ? 'out' : 'in'} ${
                  isFirstOfGroup ? 'has-tail' : ''
                } ${message.status || ''} ${message.type === 'template' ? 'is-template' : ''} ${
                  hasMedia ? 'has-media' : ''
                } ${isReaction ? 'is-reaction' : ''}`}
              >
                {message.type === 'template' && (
                  <div className="mb-template-label">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h10v2H7zm0 4h10v2H7zm0 4h7v2H7z" />
                    </svg>
                    Order confirmation
                  </div>
                )}

                {renderMessageBody(message)}

                <div className="mb-meta">
                  <span className="mb-time">{formatTime(message.created_at)}</span>
                  {isOutgoing && <StatusTicks status={message.status} />}
                </div>
              </div>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
