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

export default apiClient
