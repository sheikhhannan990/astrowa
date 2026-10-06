import axios from 'axios'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL

if (!apiBaseUrl) {
  throw new Error('Missing VITE_API_BASE_URL in environment variables')
}

const apiClient = axios.create({
  baseURL: apiBaseUrl,
  headers: {
    'Content-Type': 'application/json',
  },
})

export async function sendMessage(phone, message, conversationId) {
  try {
    const response = await apiClient.post('/send-message', {
      phone,
      message,
      conversation_id: conversationId,
    })
    return response.data
  } catch (error) {
    console.error('Failed to send message:', error)
    throw error
  }
}

// Manually override a conversation's status (used by the inbox dropdowns,
// e.g. marking a Bank Pending order as Paid once the merchant has verified
// the screenshot). Pass any subset of: { last_template, is_cancelled }.
export async function setConversationStatus(conversationId, patch) {
  try {
    const response = await apiClient.post(
      `/conversations/${conversationId}/set-status`,
      patch,
    )
    return response.data
  } catch (error) {
    console.error('Failed to update conversation status:', error)
    throw error
  }
}

// Hard-delete a single conversation (and all of its messages). Used from
// the per-row tag dropdown's "Delete conversation" action.
export async function deleteConversation(conversationId) {
  try {
    const response = await apiClient.delete(`/conversations/${conversationId}`)
    return response.data
  } catch (error) {
    console.error('Failed to delete conversation:', error)
    throw error
  }
}

// Bulk-delete the conversations selected in the inbox Select mode. One
// round trip regardless of how many rows the merchant ticked.
export async function deleteConversationsBulk(conversationIds) {
  try {
    const response = await apiClient.post('/conversations/bulk-delete', {
      ids: conversationIds,
    })
    return response.data
  } catch (error) {
    console.error('Failed to bulk delete conversations:', error)
    throw error
  }
}

// Send an image / video / voice note / document. `file` can be a File from
// an <input type="file"> or a Blob from the voice recorder. Set voice=true
// for recorded voice notes so the backend converts them to OGG/Opus (the
// format WhatsApp shows as a playable voice message).
export async function sendMedia({ phone, conversationId, file, filename, caption, voice }) {
  const form = new FormData()
  form.append('file', file, filename || file.name || 'attachment')
  form.append('phone', phone)
  form.append('conversation_id', conversationId)
  if (caption) form.append('caption', caption)
  if (voice) form.append('voice', '1')
  try {
    const response = await apiClient.post('/send-media', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // Videos can take a while to upload to WhatsApp on slow links.
      timeout: 120000,
    })
    return response.data
  } catch (error) {
    console.error('Failed to send media:', error)
    throw error
  }
}

// ---------- Quick replies (saved messages) ----------

export async function listQuickReplies() {
  const response = await apiClient.get('/quick-replies')
  return response.data
}

export async function createQuickReply(title, body) {
  const response = await apiClient.post('/quick-replies', { title, body })
  return response.data
}

export async function updateQuickReply(id, title, body) {
  const response = await apiClient.put(`/quick-replies/${id}`, { title, body })
  return response.data
}

export async function deleteQuickReply(id) {
  const response = await apiClient.delete(`/quick-replies/${id}`)
  return response.data
}

export default apiClient
