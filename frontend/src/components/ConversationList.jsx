import './ConversationList.css'

const AVATAR_GRADIENTS = [
  ['#00a884', '#008069'],
  ['#0c8c6c', '#15a37c'],
  ['#0288d1', '#01579b'],
  ['#8e24aa', '#5e35b1'],
  ['#ef6c00', '#e65100'],
  ['#c2185b', '#880e4f'],
  ['#00838f', '#006064'],
]

function gradientFor(name) {
  if (!name) return AVATAR_GRADIENTS[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length]
}

function formatDate(dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  const now = new Date()
  const isSameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()

  if (isSameDay) {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  ) {
    return 'Yesterday'
  }

  const diffMs = now - date
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' })
  }
  return date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function formatPhone(phone) {
  if (!phone) return ''
  return phone.replace(/(\d{2})(\d{3})(\d{7})/, '+$1 $2 $3')
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'confirmation', label: 'Confirmation' },
  { id: 'fulfilled', label: 'Fulfilled' },
  { id: 'cancelled', label: 'Cancelled' },
]

function statusTagFor(conversation) {
  if (conversation.is_cancelled) {
    return { label: 'Cancelled', className: 'cl-tag-cancelled' }
  }
  if (conversation.last_template === 'fulfilled') {
    return { label: 'Fulfilled', className: 'cl-tag-fulfilled' }
  }
  if (conversation.last_template === 'confirmation') {
    return { label: 'Confirmation', className: 'cl-tag-confirmation' }
  }
  return null
}

export default function ConversationList({
  conversations,
  selectedConversation,
  onSelectConversation,
  loading,
  error,
  searchTerm,
  onSearchChange,
  filter,
  onFilterChange,
  counts,
}) {
  const emptyMessage = (() => {
    if (searchTerm) return 'No matches found'
    if (filter === 'cancelled') return 'No cancelled conversations'
    if (filter === 'confirmation') return 'No conversations awaiting confirmation'
    if (filter === 'fulfilled') return 'No fulfilled conversations'
    return 'No conversations yet'
  })()

  return (
    <div className="conversation-list">
      {/* Top bar */}
      <header className="cl-topbar">
        <div className="cl-brand">
          <div className="cl-brand-avatar" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="#ffffff">
              <path d="M19.05 4.91A9.82 9.82 0 0 0 12.04 2a9.92 9.92 0 0 0-8.62 14.86L2 22l5.31-1.39a9.91 9.91 0 0 0 4.73 1.21h.01a9.93 9.93 0 0 0 9.93-9.92 9.86 9.86 0 0 0-2.93-7zM12.04 20.15h-.01a8.24 8.24 0 0 1-4.2-1.15l-.3-.18-3.13.82.84-3.05-.2-.31a8.27 8.27 0 0 1 12.86-10.2 8.2 8.2 0 0 1 2.42 5.85 8.25 8.25 0 0 1-8.28 8.22zm4.52-6.16c-.25-.13-1.47-.73-1.7-.81-.23-.08-.39-.13-.56.13-.16.25-.64.81-.78.97-.14.16-.29.18-.54.06-.25-.13-1.05-.39-2-1.23a7.55 7.55 0 0 1-1.39-1.73c-.14-.25-.02-.39.11-.51.11-.11.25-.29.38-.43.13-.14.16-.25.25-.41.08-.16.04-.31-.02-.43-.06-.13-.56-1.36-.77-1.86-.2-.49-.41-.42-.56-.43h-.48c-.16 0-.42.06-.64.31-.22.25-.84.83-.84 2.01s.86 2.34.98 2.51c.13.16 1.7 2.59 4.11 3.63.57.25 1.02.4 1.37.51.57.18 1.1.16 1.51.1.46-.07 1.42-.58 1.62-1.14.2-.56.2-1.04.14-1.14-.06-.1-.23-.16-.48-.29z" />
            </svg>
          </div>
          <h1>AstroLamps WA</h1>
        </div>
      </header>

      {/* Search */}
      <div className="cl-search-wrap">
        <div className="cl-search">
          <svg className="cl-search-icon" viewBox="0 0 24 24" width="18" height="18" fill="#54656f">
            <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99 1.49-1.49-4.99-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
          </svg>
          <input
            type="text"
            placeholder="Search or start a new chat"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="cl-search-input"
          />
        </div>
      </div>

      {/* Filter pills */}
      <div className="cl-filters" role="tablist" aria-label="Conversation filters">
        {FILTERS.map((f) => {
          const isActive = filter === f.id
          const count = counts?.[f.id] ?? 0
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`cl-filter ${isActive ? 'is-active' : ''} cl-filter-${f.id}`}
              onClick={() => onFilterChange(f.id)}
            >
              <span className="cl-filter-label">{f.label}</span>
              {count > 0 && <span className="cl-filter-count">{count}</span>}
            </button>
          )
        })}
      </div>

      {/* List */}
      <div className="cl-items">
        {loading ? (
          <div className="cl-status">Loading conversations...</div>
        ) : error ? (
          <div className="cl-status cl-status-error">Error: {error}</div>
        ) : conversations.length === 0 ? (
          <div className="cl-status">{emptyMessage}</div>
        ) : (
          conversations.map((conversation) => {
            const isActive = selectedConversation?.id === conversation.id
            const hasUnread = (conversation.unread_count || 0) > 0
            const [g1, g2] = gradientFor(conversation.customer_name || conversation.phone)
            const initial = (conversation.customer_name || 'C')[0].toUpperCase()
            const tag = statusTagFor(conversation)
            return (
              <button
                type="button"
                key={conversation.id}
                className={`cl-item ${isActive ? 'is-active' : ''} ${conversation.is_cancelled ? 'is-cancelled' : ''}`}
                onClick={() => onSelectConversation(conversation)}
              >
                <div
                  className="cl-avatar"
                  style={{ background: `linear-gradient(135deg, ${g1}, ${g2})` }}
                >
                  {initial}
                </div>

                <div className="cl-row">
                  <div className="cl-row-top">
                    <span className="cl-name truncate">
                      {conversation.customer_name || 'Unknown'}
                    </span>
                    <span
                      className={`cl-time ${hasUnread ? 'cl-time-unread' : ''}`}
                    >
                      {formatDate(conversation.last_message_at)}
                    </span>
                  </div>

                  <div className="cl-row-mid truncate">
                    <span className="cl-phone">{formatPhone(conversation.phone)}</span>
                    {conversation.order_id && (
                      <span className="cl-order" title={`Order ${conversation.order_id}`}>
                        {conversation.order_id}
                      </span>
                    )}
                    {tag && (
                      <span className={`cl-tag ${tag.className}`}>{tag.label}</span>
                    )}
                  </div>

                  <div className="cl-row-bottom">
                    <span className="cl-preview truncate">
                      {conversation.last_message || 'No messages yet'}
                    </span>
                    {hasUnread && (
                      <span className="cl-badge">{conversation.unread_count}</span>
                    )}
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
