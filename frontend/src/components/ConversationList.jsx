import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  setConversationStatus,
  deleteConversation,
  deleteConversationsBulk,
} from '../utils/api'
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
  { id: 'unread', label: 'Unread' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'pending', label: 'Pending' },
  { id: 'bankdeposit', label: 'Bank Deposit' },
  { id: 'fulfilled', label: 'Fulfilled' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'notwa', label: 'Not on WhatsApp' },
]

function statusTagFor(conversation) {
  if (conversation.is_cancelled) {
    return { label: 'Cancelled', className: 'cl-tag-cancelled', tag: 'cancelled' }
  }
  if (conversation.is_not_on_whatsapp) {
    return { label: 'Not on WhatsApp', className: 'cl-tag-notwa', tag: 'notwa' }
  }
  switch (conversation.last_template) {
    case 'fulfilled':
      return { label: 'Fulfilled', className: 'cl-tag-fulfilled', tag: 'fulfilled' }
    case 'paid':
      return { label: 'Paid', className: 'cl-tag-paid', tag: 'paid' }
    case 'confirmed':
      return { label: 'Confirmed', className: 'cl-tag-confirmed', tag: 'confirmed' }
    case 'bank_pending':
      return { label: 'Bank Pending', className: 'cl-tag-bank-pending', tag: 'bank_pending' }
    case 'confirmation':
      // A confirmation template was sent but the customer hasn't replied yet —
      // surface this as "Pending" (waiting on customer). Keep the original
      // cl-tag-confirmation class so the colour (orange) stays consistent.
      return { label: 'Pending', className: 'cl-tag-confirmation', tag: 'confirmation' }
    default:
      return null
  }
}

// All statuses the merchant can manually set from the per-row dropdown.
// The dropdown filters out whatever the conversation is currently tagged
// with, so they only ever see meaningful transitions.
const STATUS_OPTIONS = [
  { tag: 'confirmation', label: 'Pending',      patch: { last_template: 'confirmation', is_cancelled: false } },
  { tag: 'bank_pending', label: 'Bank Pending', patch: { last_template: 'bank_pending', is_cancelled: false } },
  { tag: 'confirmed',    label: 'Confirmed',    patch: { last_template: 'confirmed',    is_cancelled: false } },
  { tag: 'paid',         label: 'Paid',         patch: { last_template: 'paid',         is_cancelled: false } },
  { tag: 'fulfilled',    label: 'Fulfilled',    patch: { last_template: 'fulfilled',    is_cancelled: false } },
  { tag: 'cancelled',    label: 'Cancelled',    patch: { is_cancelled: true } },
]

function buildTagMenu(currentTag) {
  const statusItems = STATUS_OPTIONS
    .filter((opt) => opt.tag !== currentTag)
    .map((opt) => ({ kind: 'status', label: `Mark as ${opt.label}`, patch: opt.patch }))
  // Destructive option always at the bottom, visually separated.
  statusItems.push({ kind: 'delete', label: 'Delete conversation' })
  return statusItems
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
  // Tag-action dropdown state. We track the open menu's screen coordinates
  // because we render via a portal — the conversation row is itself a
  // <button> with overflow:hidden ancestors, so an inline absolute-positioned
  // menu would (a) be invalid HTML (button-in-button blocks clicks) and
  // (b) get clipped by the scroll container.
  const [openMenu, setOpenMenu] = useState(null)
  // { conversationId, actions, x, y } | null
  const [pendingTagAction, setPendingTagAction] = useState(false)

  // Bulk-select mode. When active, the top bar transforms into a selection
  // toolbar and each row shows a checkbox instead of navigating on click.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  // Drop any selection that no longer exists in the list (e.g. after a
  // realtime delete from another tab) so the toolbar's count stays honest.
  useEffect(() => {
    if (selectedIds.size === 0) return
    const liveIds = new Set(conversations.map((c) => c.id))
    let pruned = false
    const next = new Set()
    selectedIds.forEach((id) => {
      if (liveIds.has(id)) next.add(id)
      else pruned = true
    })
    if (pruned) setSelectedIds(next)
  }, [conversations, selectedIds])

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || bulkBusy) return
    const ok = window.confirm(
      `Delete ${ids.length} conversation${ids.length === 1 ? '' : 's'}? ` +
        `All messages will be permanently removed. This cannot be undone.`,
    )
    if (!ok) return
    setBulkBusy(true)
    try {
      await deleteConversationsBulk(ids)
      exitSelectMode()
    } catch (err) {
      alert('Could not delete. ' + (err?.response?.data?.error || err.message))
    } finally {
      setBulkBusy(false)
    }
  }

  // Close on outside click, scroll, resize, or Escape. Listeners are
  // registered AFTER the open click finishes propagating (useEffect timing)
  // so they don't immediately fire and dismiss the menu we just opened.
  useEffect(() => {
    if (!openMenu) return
    const close = () => setOpenMenu(null)
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [openMenu])

  const handleTagClick = (event, conversationId, actions) => {
    event.stopPropagation()
    if (!actions || actions.length === 0) return
    if (openMenu?.conversationId === conversationId) {
      setOpenMenu(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setOpenMenu({
      conversationId,
      actions,
      x: rect.left,
      y: rect.bottom + 4,
    })
  }

  const handleTagAction = async (event, conversationId, action) => {
    event.stopPropagation()
    setOpenMenu(null)
    if (pendingTagAction) return

    if (action.kind === 'delete') {
      const ok = window.confirm(
        'Delete this conversation? All messages will be permanently removed. ' +
          'This cannot be undone.',
      )
      if (!ok) return
      setPendingTagAction(true)
      try {
        await deleteConversation(conversationId)
      } catch (err) {
        alert('Could not delete. ' + (err?.response?.data?.error || err.message))
      } finally {
        setPendingTagAction(false)
      }
      return
    }

    setPendingTagAction(true)
    try {
      await setConversationStatus(conversationId, action.patch)
      // Realtime subscription on conversations will refetch and rerender.
    } catch (err) {
      alert('Could not update status. ' + (err?.response?.data?.error || err.message))
    } finally {
      setPendingTagAction(false)
    }
  }

  const emptyMessage = (() => {
    if (searchTerm) return 'No matches found'
    if (filter === 'cancelled') return 'No cancelled conversations'
    if (filter === 'unread') return 'No unread conversations'
    if (filter === 'pending') return 'No conversations awaiting customer reply'
    if (filter === 'bankdeposit') return 'No bank deposit orders'
    if (filter === 'confirmed') return 'No confirmed orders ready to ship'
    if (filter === 'fulfilled') return 'No fulfilled conversations'
    if (filter === 'notwa') return 'No customers flagged as Not on WhatsApp'
    return 'No conversations yet'
  })()

  return (
    <div className="conversation-list">
      {/* Top bar — transforms into a selection toolbar in select mode. */}
      <header className={`cl-topbar ${selectMode ? 'is-select-mode' : ''}`}>
        {selectMode ? (
          <div className="cl-select-bar" role="toolbar" aria-label="Selection actions">
            <button
              type="button"
              className="cl-select-cancel"
              onClick={exitSelectMode}
              aria-label="Exit selection mode"
              title="Cancel"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
              </svg>
            </button>
            <span className="cl-select-count">
              {selectedIds.size > 0
                ? `${selectedIds.size} selected`
                : 'Select chats'}
            </span>
            <button
              type="button"
              className="cl-select-delete"
              onClick={handleBulkDelete}
              disabled={selectedIds.size === 0 || bulkBusy}
              title="Delete selected"
              aria-label="Delete selected"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
                <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
              </svg>
              <span>{bulkBusy ? 'Deleting…' : 'Delete'}</span>
            </button>
          </div>
        ) : (
          <>
            <div className="cl-brand">
              <div className="cl-brand-avatar" aria-hidden>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="#ffffff">
                  <path d="M19.05 4.91A9.82 9.82 0 0 0 12.04 2a9.92 9.92 0 0 0-8.62 14.86L2 22l5.31-1.39a9.91 9.91 0 0 0 4.73 1.21h.01a9.93 9.93 0 0 0 9.93-9.92 9.86 9.86 0 0 0-2.93-7zM12.04 20.15h-.01a8.24 8.24 0 0 1-4.2-1.15l-.3-.18-3.13.82.84-3.05-.2-.31a8.27 8.27 0 0 1 12.86-10.2 8.2 8.2 0 0 1 2.42 5.85 8.25 8.25 0 0 1-8.28 8.22zm4.52-6.16c-.25-.13-1.47-.73-1.7-.81-.23-.08-.39-.13-.56.13-.16.25-.64.81-.78.97-.14.16-.29.18-.54.06-.25-.13-1.05-.39-2-1.23a7.55 7.55 0 0 1-1.39-1.73c-.14-.25-.02-.39.11-.51.11-.11.25-.29.38-.43.13-.14.16-.25.25-.41.08-.16.04-.31-.02-.43-.06-.13-.56-1.36-.77-1.86-.2-.49-.41-.42-.56-.43h-.48c-.16 0-.42.06-.64.31-.22.25-.84.83-.84 2.01s.86 2.34.98 2.51c.13.16 1.7 2.59 4.11 3.63.57.25 1.02.4 1.37.51.57.18 1.1.16 1.51.1.46-.07 1.42-.58 1.62-1.14.2-.56.2-1.04.14-1.14-.06-.1-.23-.16-.48-.29z" />
                </svg>
              </div>
              <h1>AstroLamps WA</h1>
            </div>
            <button
              type="button"
              className="cl-topbar-action"
              onClick={() => setSelectMode(true)}
              title="Select chats"
              aria-label="Select chats"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
                <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </button>
          </>
        )}
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

      {/* Tag dropdown — portalled to <body> so it escapes the row button
          (HTML doesn't allow nested buttons) and the scroll container's
          overflow clipping. */}
      {openMenu &&
        createPortal(
          <div
            className="cl-tag-menu"
            role="menu"
            style={{ top: openMenu.y, left: openMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {openMenu.actions.map((action, idx) => {
              const isDelete = action.kind === 'delete'
              const prev = openMenu.actions[idx - 1]
              const needsDivider = isDelete && prev && prev.kind !== 'delete'
              return (
                <div key={action.label}>
                  {needsDivider && <div className="cl-tag-menu-divider" aria-hidden />}
                  <button
                    type="button"
                    role="menuitem"
                    className={`cl-tag-menu-item ${isDelete ? 'is-destructive' : ''}`}
                    disabled={pendingTagAction}
                    onClick={(e) => handleTagAction(e, openMenu.conversationId, action)}
                  >
                    {action.label}
                  </button>
                </div>
              )
            })}
          </div>,
          document.body,
        )}

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
            const isSelected = selectedIds.has(conversation.id)

            const onRowClick = () => {
              if (selectMode) toggleSelected(conversation.id)
              else onSelectConversation(conversation)
            }

            return (
              <button
                type="button"
                key={conversation.id}
                className={`cl-item ${isActive ? 'is-active' : ''} ${
                  conversation.is_cancelled ? 'is-cancelled' : ''
                } ${isSelected ? 'is-selected' : ''}`}
                onClick={onRowClick}
              >
                {selectMode ? (
                  <span
                    className={`cl-row-check ${isSelected ? 'is-on' : ''}`}
                    aria-hidden
                  >
                    {isSelected && (
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="#ffffff">
                        <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                      </svg>
                    )}
                  </span>
                ) : null}

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
                    {tag && (() => {
                      // In Select mode the row click toggles selection — we
                      // don't want a tag click to also fire and open a menu.
                      const hasActions = !selectMode
                      const actions = hasActions ? buildTagMenu(tag.tag) : null
                      const onActivate = (e) => handleTagClick(e, conversation.id, actions)
                      return (
                        <span
                          className={`cl-tag ${tag.className} ${hasActions ? 'cl-tag-clickable' : ''}`}
                          role={hasActions ? 'button' : undefined}
                          tabIndex={hasActions ? 0 : undefined}
                          onClick={hasActions ? onActivate : undefined}
                          onKeyDown={
                            hasActions
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    onActivate(e)
                                  }
                                }
                              : undefined
                          }
                          title={hasActions ? 'Click to change status' : undefined}
                        >
                          {tag.label}
                          {hasActions && (
                            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className="cl-tag-caret">
                              <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                      )
                    })()}
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
