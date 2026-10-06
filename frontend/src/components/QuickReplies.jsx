import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import {
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
} from '../utils/api'
import './QuickReplies.css'

// Shared across every chat so switching conversations doesn't refetch.
let cache = null // { items, persisted }

// Instagram-style saved replies. Opened from the ⚡ button or by typing "/"
// at the start of the message box (the text after "/" filters the list).
// Picking one hands its text back to the composer so it can be tweaked
// before sending.
const QuickReplies = forwardRef(function QuickReplies({ query, onPick, onClose }, ref) {
  const [items, setItems] = useState(cache?.items || [])
  const [persisted, setPersisted] = useState(cache?.persisted ?? true)
  const [loading, setLoading] = useState(!cache)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // null | { id?, title, body }
  const [saving, setSaving] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    listQuickReplies()
      .then((res) => {
        if (cancelled) return
        cache = { items: res.quick_replies || [], persisted: res.persisted !== false }
        setItems(cache.items)
        setPersisted(cache.persisted)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load quick replies')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = (query || '').trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (it) => it.title.toLowerCase().includes(q) || it.body.toLowerCase().includes(q),
    )
  }, [items, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const commit = (next) => {
    cache = { items: next, persisted }
    setItems(next)
  }

  // Lets the composer drive the list from the textarea while in "/" mode:
  // ↑/↓ to move, Enter/Tab to pick, Esc to close.
  useImperativeHandle(ref, () => ({
    handleKey(e) {
      if (editing) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!filtered.length) return false
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((i) => (i + step + filtered.length) % filtered.length)
        return true
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && filtered[activeIndex]) {
        onPick(filtered[activeIndex].body)
        return true
      }
      if (e.key === 'Escape') {
        onClose()
        return true
      }
      return false
    },
  }))

  async function handleSave(e) {
    e.preventDefault()
    const title = editing.title.trim()
    const body = editing.body.trim()
    if (!title || !body || saving) return
    setSaving(true)
    setError(null)
    try {
      if (editing.id) {
        const res = await updateQuickReply(editing.id, title, body)
        commit(items.map((it) => (it.id === editing.id ? res.quick_reply : it)))
      } else {
        const res = await createQuickReply(title, body)
        commit([...items, res.quick_reply])
      }
      setEditing(null)
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save quick reply')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(item) {
    if (!window.confirm(`Delete the quick reply "${item.title}"?`)) return
    setError(null)
    try {
      await deleteQuickReply(item.id)
      commit(items.filter((it) => it.id !== item.id))
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete quick reply')
    }
  }

  return (
    <div className="qr-panel" role="dialog" aria-label="Quick replies">
      <div className="qr-head">
        <span className="qr-title">
          {editing ? (editing.id ? 'Edit quick reply' : 'New quick reply') : 'Quick replies'}
        </span>
        {!editing && persisted && (
          <button
            type="button"
            className="qr-new"
            onClick={() => setEditing({ title: '', body: '' })}
          >
            + New
          </button>
        )}
        <button type="button" className="qr-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {error && <div className="qr-error">{error}</div>}

      {editing ? (
        <form className="qr-form" onSubmit={handleSave}>
          <input
            className="qr-input"
            placeholder="Title (e.g. Bank details)"
            value={editing.title}
            maxLength={80}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            autoFocus
          />
          <textarea
            className="qr-input qr-textarea"
            placeholder="Message"
            value={editing.body}
            rows={6}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
          <div className="qr-form-actions">
            <button type="button" className="qr-btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="submit"
              className="qr-btn qr-btn-primary"
              disabled={saving || !editing.title.trim() || !editing.body.trim()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <div className="qr-list">
          {!persisted && (
            <div className="qr-note">
              Showing the default replies. To add or edit your own, run the
              quick_replies SQL in Supabase.
            </div>
          )}
          {loading && !items.length ? (
            <div className="qr-empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="qr-empty">
              {query ? `No quick reply matches "/${query}"` : 'No quick replies yet'}
            </div>
          ) : (
            filtered.map((item, idx) => (
              <div
                key={item.id}
                className={`qr-item ${idx === activeIndex ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <button type="button" className="qr-item-main" onClick={() => onPick(item.body)}>
                  <span className="qr-item-title">{item.title}</span>
                  <span className="qr-item-body">{item.body}</span>
                </button>
                {persisted && (
                  <div className="qr-item-actions">
                    <button
                      type="button"
                      className="qr-icon-btn"
                      title="Edit"
                      aria-label={`Edit ${item.title}`}
                      onClick={() => setEditing({ id: item.id, title: item.title, body: item.body })}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="qr-icon-btn is-destructive"
                      title="Delete"
                      aria-label={`Delete ${item.title}`}
                      onClick={() => handleDelete(item)}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                        <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
          <div className="qr-hint">Tip: type “/” in the message box to search quick replies.</div>
        </div>
      )}
    </div>
  )
})

export default QuickReplies
