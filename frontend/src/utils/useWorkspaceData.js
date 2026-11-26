import { useCallback, useEffect, useState } from 'react'
import { supabase, fetchPaged } from './supabaseClient'
import { getConfig } from './api'

// A month of orders, so Yesterday / Last 7 days / 30 days filters are instant.
const ORDER_DAYS = 31

function byLastMessageDesc(a, b) {
  const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0
  const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0
  return tb - ta
}

// Merge one realtime postgres_changes event into a list of rows.
function applyChange(list, payload, sort) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id
    return id ? list.filter((r) => r.id !== id) : list
  }
  const row = payload.new
  if (!row?.id) return list
  const exists = list.some((r) => r.id === row.id)
  const next = exists ? list.map((r) => (r.id === row.id ? { ...r, ...row } : r)) : [row, ...list]
  return sort ? next.sort(sort) : next
}

// Chats and recent orders, kept live with Supabase
// realtime. Shared by the Today queue and the Inbox.
export default function useWorkspaceData() {
  const [conversations, setConversations] = useState([])
  const [orders, setOrders] = useState([])
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchConversations = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('conversations')
      .select('*')
      .order('last_message_at', { ascending: false })
    if (err) throw err
    setConversations(data || [])
  }, [])

  const fetchOrders = useCallback(async () => {
    const since = new Date(Date.now() - ORDER_DAYS * 86400000).toISOString()
    const rows = await fetchPaged((from, to) =>
      supabase
        .from('orders')
        .select('*')
        .gte('order_created_at', since)
        .order('order_created_at', { ascending: false })
        .range(from, to)
    )
    setOrders(rows)
  }, [])

  const refreshAll = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true)
      await Promise.all([fetchConversations(), fetchOrders()])
      setError(null)
    } catch (err) {
      console.error('Failed to load workspace data:', err)
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [fetchConversations, fetchOrders])

  useEffect(() => {
    refreshAll()
    getConfig().then(setConfig).catch(() => setConfig(null))
  }, [refreshAll])

  useEffect(() => {
    const channel = supabase
      .channel('workspace')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' },
        (p) => setConversations((prev) => applyChange(prev, p, byLastMessageDesc)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },
        (p) => setOrders((prev) => applyChange(prev, p)))
      .subscribe((status) => {
        // Full refresh on every (re)connect so nothing is missed.
        if (status === 'SUBSCRIBED') refreshAll({ silent: true })
      })
    return () => {
      supabase.removeChannel(channel)
    }
  }, [refreshAll])

  const patchConversation = useCallback((id, fields) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...fields } : c)))
  }, [])

  // Apply an order returned by the API right away (realtime will confirm).
  const upsertOrder = useCallback((order) => {
    if (!order?.id) return
    setOrders((prev) => applyChange(prev, { eventType: 'UPDATE', new: order }))
  }, [])

  return {
    conversations, orders, config, loading, error,
    refreshAll, patchConversation, upsertOrder,
  }
}
