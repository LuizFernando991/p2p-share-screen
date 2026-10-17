import { useEffect, useState, type FormEvent } from 'react'

import type { Session } from '../../../shared/api'
import { messageFor } from '../lib/api'

export function Login({ expired, onLogin }: { expired?: boolean; onLogin: (session: Session) => void }) {
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(expired ? messageFor('not_logged_in', '') : '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.auth.defaultServer().then(setServer)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const res = await window.api.auth.login(server, username, password)
    setBusy(false)
    if (res.ok) onLogin(res.data)
    else setError(messageFor(res.error.code, res.error.message))
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>ShareScreen</h1>
        <p className="muted">Entre com a conta criada pelo administrador.</p>
        <label>
          Servidor
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://share.exemplo.com" required />
        </label>
        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}
