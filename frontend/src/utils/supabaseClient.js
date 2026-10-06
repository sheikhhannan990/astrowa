import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Please check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Supabase (PostgREST) caps every request at 1000 rows by default. To load
// more than that we page through with .range() until we either run out of
// rows or hit MAX_ROWS.
export const MAX_ROWS = 2000
const PAGE_SIZE = 1000

// buildQuery(from, to) must return a fresh query with .range(from, to)
// applied. Returns the concatenated rows (throws on the first error).
export async function fetchAllRows(buildQuery, maxRows = MAX_ROWS) {
  const rows = []
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, maxRows) - 1
    const { data, error } = await buildQuery(from, to)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < to - from + 1) break
  }
  return rows
}
