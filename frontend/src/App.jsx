import { useState, useEffect } from 'react'
import { supabase } from './utils/supabaseClient'
import ConversationList from './components/ConversationList'
import ChatWindow from './components/ChatWindow'
import './App.css'

export default function App() {
  const [conversations, setConversations] = useState([])
  const [selectedConversationId, setSelectedConversationId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  // Filter pills: 'all' | 'confirmation' | 'fulfilled' | 'cancelled'.
  // 'all' excludes cancelled chats (archive-style); 'cancelled' shows only them.
  const [filter, setFilter] = useState('all')
  const [isMobileView, setIsMobileView] = useState(
    typeof window !== 'undefined' && window.innerWidth < 900
  )

  useEffect(() => {
    fetchConversations()

    const handleResize = () => {
      setIsMobileView(window.innerWidth < 900)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Keep the conversation list in sync with realtime DB changes.
  useEffect(() => {
    const subscription = supabase
      .channel('conversations_channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        () => {
          fetchConversations()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(subscription)
    }
  }, [])

  async function fetchConversations() {
    try {
      setLoading(true)
      const { data, error: err } = await supabase
        .from('conversations')
        .select('*')
        .order('last_message_at', { ascending: false })

      if (err) throw err

      setConversations(data || [])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch conversations:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSelectConversation = (conversation) => {
    setSelectedConversationId(conversation?.id ?? null)
  }

  const handleBackFromChat = () => {
    setSelectedConversationId(null)
  }

  // Always read the latest version of the selected conversation from the
  // refreshed list so unread_count / last_message stay in sync.
  const selectedConversation =
    conversations.find((c) => c.id === selectedConversationId) || null

  // Counts driven by the unfiltered list so the pill badges always reflect
  // reality even when the user is mid-search.
  const counts = conversations.reduce(
    (acc, c) => {
      if (c.is_cancelled) acc.cancelled += 1
      else {
        acc.all += 1
        if ((c.unread_count || 0) > 0) acc.unread += 1
        if (c.last_template === 'confirmation') acc.confirmation += 1
        else if (c.last_template === 'fulfilled') acc.fulfilled += 1
      }
      return acc
    },
    { all: 0, unread: 0, confirmation: 0, fulfilled: 0, cancelled: 0 }
  )

  const filteredConversations = conversations.filter((conv) => {
    if (filter === 'cancelled') {
      if (!conv.is_cancelled) return false
    } else {
      if (conv.is_cancelled) return false
      if (filter === 'unread' && !((conv.unread_count || 0) > 0)) return false
      if (filter === 'confirmation' && conv.last_template !== 'confirmation') return false
      if (filter === 'fulfilled' && conv.last_template !== 'fulfilled') return false
    }

    if (!searchTerm) return true
    const searchLower = searchTerm.toLowerCase()
    return (
      (conv.customer_name && conv.customer_name.toLowerCase().includes(searchLower)) ||
      (conv.phone && conv.phone.includes(searchLower)) ||
      (conv.order_id && String(conv.order_id).toLowerCase().includes(searchLower))
    )
  })

  const list = (
    <ConversationList
      conversations={filteredConversations}
      selectedConversation={selectedConversation}
      onSelectConversation={handleSelectConversation}
      loading={loading}
      error={error}
      searchTerm={searchTerm}
      onSearchChange={setSearchTerm}
      filter={filter}
      onFilterChange={setFilter}
      counts={counts}
    />
  )

  return (
    <div className="app">
      {isMobileView ? (
        <div className="mobile-view">
          {selectedConversation ? (
            <ChatWindow
              conversation={selectedConversation}
              onBack={handleBackFromChat}
              onConversationUpdate={fetchConversations}
              isMobile
            />
          ) : (
            list
          )}
        </div>
      ) : (
        <div className="desktop-view">
          <aside className="sidebar">{list}</aside>
          <main className="main-content">
            {selectedConversation ? (
              <ChatWindow
                conversation={selectedConversation}
                onConversationUpdate={fetchConversations}
              />
            ) : (
              <div className="no-selection">
                <div className="no-selection-illustration" aria-hidden>
                  <svg viewBox="0 0 303 172" width="320" height="180">
                    <defs>
                      <linearGradient id="lg" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0" stopColor="#daf7dc" />
                        <stop offset="1" stopColor="#b9eac4" />
                      </linearGradient>
                    </defs>
                    <path
                      fill="url(#lg)"
                      d="M229.6 9.8c-7-1.2-14.1-1.7-21.1-1.7-78.9 0-128 71.7-128 128 0 12.9 1.6 25.5 4.6 37.4-1.4-2.4-2.5-5-3.2-7.7-3.7-13.7-1.5-28 7.4-39.3 7.4-9.5 18-15.7 30-17.4 4-13.2 11.5-25.1 21.7-34.6 14.7-13.6 33.9-21.1 54-21.1 11.2 0 22.1 2.3 32 6.7-1.4-1-2.9-1.9-4.4-2.6-3.5-1.7-7.2-3-11-4.1-3-.9-6.1-1.6-9.3-2.2 3.5-.7 7-1.2 10.6-1.4 5.9-.3 11.8 0 17.7 1z"
                      opacity="0.5"
                    />
                    <circle cx="150" cy="86" r="42" fill="#fff" opacity="0.6" />
                    <path
                      d="M150 56c-19.3 0-35 13.4-35 30 0 9.2 4.9 17.5 12.6 23l-2.5 11.5c-.3 1.3 1.1 2.3 2.3 1.6l13.4-7.2c2.9.8 6 1.2 9.2 1.2 19.3 0 35-13.4 35-30s-15.7-30-35-30z"
                      fill="#00a884"
                      opacity="0.85"
                    />
                  </svg>
                </div>
                <h2>AstroLamps WhatsApp</h2>
                <p>
                  Send and receive messages with your customers. Select a conversation from
                  the sidebar to start chatting.
                </p>
                <div className="no-selection-footer">
                  <span>🔒 End-to-end encrypted on WhatsApp</span>
                </div>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}
