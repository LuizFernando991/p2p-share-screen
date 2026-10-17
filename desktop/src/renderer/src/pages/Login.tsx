import { Settings } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import type { Session } from '../../../shared/api'
import { ServerDialog } from '../components/Dialogs'
import { messageFor } from '../lib/api'

export function Login({ expired, onLogin }: { expired?: boolean; onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(expired ? messageFor('not_logged_in', '') : '')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const res = await window.api.auth.login(username, password)
    setBusy(false)
    if (res.ok) onLogin(res.data)
    else if (res.error.code === 'network_error') setError(`${messageFor('network_error', '')} Confira o servidor em Configurações.`)
    else setError(messageFor(res.error.code, res.error.message))
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <button
          type="button"
          className="icon login-settings"
          title="Configurações"
          aria-label="Configurações"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={16} />
        </button>
        <h1>ShareScreen</h1>
        <p className="muted">Entre com a conta criada pelo administrador.</p>
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
      {settingsOpen && <ServerDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
