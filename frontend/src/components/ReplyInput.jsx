import { useRef, useState, useEffect } from 'react'
import { sendMessage, sendMedia } from '../utils/api'
import QuickReplies from './QuickReplies'
import './ReplyInput.css'

// WhatsApp's hard ceiling for any attachment (documents); images, videos
// and audio have lower limits that the backend enforces with a clear error.
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

// Formats the browser can record in, best-for-WhatsApp first. OGG/Opus and
// MP4/AAC are accepted by WhatsApp as-is; WebM (Chrome) is converted to
// OGG/Opus by the backend.
const RECORDER_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
]

function pickRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return ''
  return RECORDER_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || ''
}

function extForMime(mime) {
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('webm')) return 'webm'
  return 'audio'
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function attachmentKind(file) {
  const t = (file?.type || '').toLowerCase()
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  return 'document'
}

export default function ReplyInput({ conversation }) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [showQuickReplies, setShowQuickReplies] = useState(false)
  const [attachment, setAttachment] = useState(null) // { file, previewUrl }
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)

  const wrapRef = useRef(null)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const quickRepliesRef = useRef(null)
  const recorderRef = useRef(null)
  const recordChunksRef = useRef([])
  const recordCancelledRef = useRef(false)
  const recordTimerRef = useRef(null)

  // "/" at the very start of the box opens quick replies and filters them.
  const slashQuery = message.startsWith('/') && !message.includes('\n') ? message.slice(1) : null
  const quickRepliesOpen = showQuickReplies || slashQuery !== null

  useEffect(() => {
    setMessage('')
    setError(null)
    setShowQuickReplies(false)
    clearAttachment()
    cancelRecording()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id])

  // Stop the mic and release object URLs when the chat unmounts.
  useEffect(() => {
    return () => {
      cancelRecording()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [attachment])

  // Close the quick-replies panel when clicking anywhere outside the composer.
  useEffect(() => {
    if (!showQuickReplies) return
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setShowQuickReplies(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showQuickReplies])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [message])

  function clearAttachment() {
    setAttachment(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleFileChosen(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError('That file is larger than 100 MB, which WhatsApp does not allow.')
      e.target.value = ''
      return
    }
    const kind = attachmentKind(file)
    setError(null)
    setShowQuickReplies(false)
    setAttachment({
      file,
      kind,
      previewUrl: kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null,
    })
    textareaRef.current?.focus()
  }

  function handlePickQuickReply(body) {
    setShowQuickReplies(false)
    setMessage((prev) => {
      // Slash-triggered or empty box → replace; otherwise append.
      if (!prev.trim() || prev.startsWith('/')) return body
      return `${prev.replace(/\s+$/, '')}\n${body}`
    })
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  function closeQuickReplies() {
    setShowQuickReplies(false)
    if (slashQuery !== null) setMessage('')
  }

  async function sendCurrent(e) {
    e?.preventDefault?.()
    if (sending) return
    const text = message.trim()

    if (attachment) {
      await sendFile({
        file: attachment.file,
        filename: attachment.file.name,
        caption: text,
        voice: false,
      })
      return
    }

    if (!text) return
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

  async function sendFile({ file, filename, caption, voice }) {
    setSending(true)
    setError(null)
    try {
      await sendMedia({
        phone: conversation.phone,
        conversationId: conversation.id,
        file,
        filename,
        caption,
        voice,
      })
      if (!voice) {
        clearAttachment()
        setMessage('')
      }
    } catch (err) {
      console.error('Failed to send media:', err)
      setError(err.response?.data?.error || 'Failed to send attachment')
    } finally {
      setSending(false)
    }
  }

  // ---------- Voice notes ----------

  async function startRecording() {
    if (recording || sending) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is not supported in this browser.')
      return
    }
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone access was blocked. Allow it in the browser to record voice notes.')
      return
    }

    const mimeType = pickRecorderMimeType()
    let recorder
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      setError('Could not start the voice recorder in this browser.')
      return
    }

    recordChunksRef.current = []
    recordCancelledRef.current = false
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordChunksRef.current.push(ev.data)
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      clearInterval(recordTimerRef.current)
      recorderRef.current = null
      setRecording(false)
      if (recordCancelledRef.current) return
      const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0]
      const blob = new Blob(recordChunksRef.current, { type })
      if (blob.size === 0) return
      sendFile({ file: blob, filename: `voice-note.${extForMime(type)}`, caption: '', voice: true })
    }

    recorderRef.current = recorder
    recorder.start()
    setError(null)
    setShowQuickReplies(false)
    setRecordSeconds(0)
    setRecording(true)
    recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
  }

  function stopAndSendRecording() {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
  }

  function cancelRecording() {
    recordCancelledRef.current = true
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    clearInterval(recordTimerRef.current)
    setRecording(false)
  }

  const handleKeyDown = (e) => {
    if (quickRepliesOpen && quickRepliesRef.current?.handleKey(e)) {
      e.preventDefault()
      return
    }
    // Enter inserts a newline (textarea default). Ctrl/Cmd+Enter sends —
    // a power-user shortcut so you don't have to reach for the mouse.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      sendCurrent(e)
    }
  }

  const hasText = message.trim().length > 0
  const canSend = hasText || !!attachment

  return (
    <div className="ri-wrap" ref={wrapRef}>
      {error && (
        <div className="ri-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {quickRepliesOpen && !recording && (
        <QuickReplies
          ref={quickRepliesRef}
          query={slashQuery ?? ''}
          onPick={handlePickQuickReply}
          onClose={closeQuickReplies}
        />
      )}

      {attachment && (
        <div className="ri-attachment">
          {attachment.kind === 'image' ? (
            <img src={attachment.previewUrl} alt="" className="ri-attachment-thumb" />
          ) : attachment.kind === 'video' ? (
            <video src={attachment.previewUrl} className="ri-attachment-thumb" muted />
          ) : (
            <span className="ri-attachment-icon" aria-hidden>
              {attachment.kind === 'audio' ? '🎵' : '📄'}
            </span>
          )}
          <div className="ri-attachment-info">
            <span className="ri-attachment-name truncate">{attachment.file.name}</span>
            <span className="ri-attachment-meta">
              {formatSize(attachment.file.size)}
              {attachment.kind !== 'audio' && ' · type a caption below (optional)'}
            </span>
          </div>
          <button
            type="button"
            className="ri-attachment-remove"
            onClick={clearAttachment}
            disabled={sending}
            aria-label="Remove attachment"
          >
            ×
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
        onChange={handleFileChosen}
        hidden
      />

      {recording ? (
        <div className="ri-form ri-recording" role="status" aria-live="polite">
          <button
            type="button"
            className="ri-icon ri-record-cancel"
            onClick={cancelRecording}
            aria-label="Discard voice note"
            title="Discard"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
              <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
            </svg>
          </button>
          <div className="ri-record-indicator">
            <span className="ri-record-dot" aria-hidden />
            <span className="ri-record-time">{formatDuration(recordSeconds)}</span>
            <span className="ri-record-label">Recording voice note…</span>
          </div>
          <button
            type="button"
            className="ri-send is-send"
            onClick={stopAndSendRecording}
            aria-label="Send voice note"
            title="Send voice note"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      ) : (
        <form className="ri-form" onSubmit={sendCurrent}>
          <button
            type="button"
            className={`ri-icon ri-quick ${quickRepliesOpen ? 'is-active' : ''}`}
            aria-label="Quick replies"
            title="Quick replies (or type /)"
            onClick={() => (quickRepliesOpen ? closeQuickReplies() : setShowQuickReplies(true))}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
              <path d="M7 2v11h3v9l7-12h-4l4-8z" />
            </svg>
          </button>

          <button
            type="button"
            className="ri-icon ri-attach"
            aria-label="Attach photo, video or file"
            title="Attach photo, video or file"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M16.5 6.5v10.79a4.71 4.71 0 0 1-4.5 4.71A4.71 4.71 0 0 1 7.5 17.29V6.71a3.71 3.71 0 0 1 7.42 0v9.79a2.71 2.71 0 0 1-5.42 0V8h1.5v8.5a1.21 1.21 0 0 0 2.42 0V6.71a2.21 2.21 0 0 0-4.42 0v10.58a3.21 3.21 0 0 0 6.42 0V6.5h1.58z" />
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={attachment ? 'Add a caption' : 'Type a message or / for quick replies'}
            disabled={sending}
            className="ri-textarea"
            rows={1}
          />

          {canSend || sending ? (
            <button
              type="submit"
              className="ri-send is-send"
              disabled={sending}
              aria-label="Send"
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
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="ri-send is-mic"
              onClick={startRecording}
              aria-label="Record voice note"
              title="Record voice note"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
              </svg>
            </button>
          )}
        </form>
      )}
    </div>
  )
}
