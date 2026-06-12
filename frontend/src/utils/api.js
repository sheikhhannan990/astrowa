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

export default apiClient
