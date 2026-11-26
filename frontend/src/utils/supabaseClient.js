import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Please check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Supabase returns at most 1000 rows per request; page through with
// .range() for lists that can be bigger (e.g. two weeks of orders).
export async function fetchPaged(buildQuery, maxRows = 3000) {
  const rows = []
  for (let from = 0; from < maxRows; from += 1000) {
    const { data, error } = await buildQuery(from, from + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return rows
}
