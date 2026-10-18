import { Hash, Timer, X } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import type { Room, RoomType } from '../../../shared/api'
import { api, errorMessage, messageFor } from '../lib/api'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

export function CreateRoomDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (room: Room) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<RoomType>('restricted')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      onCreated(await api.rooms.create(name, type))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Criar sala" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus required />
        </label>
        <div className="choice-group">
          <label className={`choice ${type === 'restricted' ? 'selected' : ''}`}>
            <input type="radio" checked={type === 'restricted'} onChange={() => setType('restricted')} />
            <strong className="choice-title">
              <Hash size={15} /> Fixa
            </strong>
            <span className="muted small">Permanente. Você escolhe quem são os membros.</span>
          </label>
          <label className={`choice ${type === 'private' ? 'selected' : ''}`}>
            <input type="radio" checked={type === 'private'} onChange={() => setType('private')} />
            <strong className="choice-title">
              <Timer size={15} /> Temporária
            </strong>
            <span className="muted small">Entra quem tiver o código. Some quando fica vazia.</span>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Criar
        </button>
      </form>
    </Modal>
  )
}

export function JoinCodeDialog({ onClose, onJoined }: { onClose: () => void; onJoined: (room: Room) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      onJoined(await api.rooms.joinByCode(code))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Entrar com código" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label>
          Código de convite
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="K7QF-2MXP"
            className="code-input"
            autoFocus
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Entrar
        </button>
      </form>
    </Modal>
  )
}

/** Login-screen settings: the server address (rarely changed, so kept out of the form). */
export function ServerDialog({ onClose }: { onClose: () => void }) {
  const [server, setServer] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void window.api.settings.server().then(setServer)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const res = await window.api.settings.setServer(server)
    if (res.ok) onClose()
    else setError(messageFor(res.error.code, res.error.message))
  }

  return (
    <Modal title="Configurações" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label>
          Servidor
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="https://share.exemplo.com"
            required
            autoFocus
          />
        </label>
        <p className="muted small">Endereço do servidor da sua equipe. Só mude se o administrador pedir.</p>
        {error && <p className="error">{error}</p>}
        <button className="primary">Salvar</button>
      </form>
    </Modal>
  )
}

/** In-app settings: account (password) and the connected server. */
export function SettingsDialog({ server, onClose }: { server: string; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [audioApps, setAudioApps] = useState('')
  const [audioDone, setAudioDone] = useState(false)

  useEffect(() => {
    void window.api.settings.audioExcludedApps().then((apps) => setAudioApps(apps.join('\n')))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const res = await window.api.auth.changePassword(current, next)
    if (res.ok) {
      setDone(true)
      setCurrent('')
      setNext('')
    } else setError(messageFor(res.error.code, res.error.message))
  }

  return (
    <Modal title="Configurações" onClose={onClose}>
      <div className="stack">
        <section className="settings-section">
          <h3>Conta</h3>
          <form onSubmit={submit} className="stack">
            <label>
              Senha atual
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </label>
            <label>
              Nova senha
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required />
            </label>
            {error && <p className="error">{error}</p>}
            {done && <p className="success">Senha alterada. As outras sessões da sua conta foram encerradas.</p>}
            <button className="primary">Trocar senha</button>
          </form>
        </section>
        <section className="settings-section">
          <h3>Áudio compartilhado</h3>
          <label>
            Aplicativos que não devem ser compartilhados
            <textarea
              value={audioApps}
              onChange={(e) => {
                setAudioApps(e.target.value)
                setAudioDone(false)
              }}
              rows={4}
              placeholder="Discord\nDiscord PTB"
            />
          </label>
          <p className="muted small">
            Um nome por linha. No Linux, use o nome do aplicativo exibido pelo PipeWire. A alteração vale na próxima
            transmissão.
          </p>
          <button
            className="primary"
            onClick={async () => {
              await window.api.settings.setAudioExcludedApps(
                audioApps
                  .split('\n')
                  .map((appName) => appName.trim())
                  .filter(Boolean)
              )
              setAudioDone(true)
            }}
          >
            Salvar áudio
          </button>
          {audioDone && <p className="success">Configuração de áudio salva.</p>}
        </section>
        <section className="settings-section">
          <h3>Servidor</h3>
          <code className="server-url">{server}</code>
          <p className="muted small">Para usar outro servidor, saia da conta e mude em Configurações na tela de login.</p>
        </section>
      </div>
    </Modal>
  )
}
