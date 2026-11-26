import { useState } from 'react'
import { supabase } from '../utils/supabaseClient'
import './views.css'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (err) setError(err.message === 'Invalid login credentials' ? 'Wrong email or password.' : err.message)
    setBusy(false)
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-logo" aria-hidden>💡</span>
          <div>
            <h1>AstroLamps Inbox</h1>
            <p>Sign in to manage orders and chats</p>
          </div>
        </div>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button type="submit" className="td-btn td-btn-primary login-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="login-help">Forgot your password? Ask the admin to reset it from the Team page.</p>
      </form>
    </div>
  )
}
