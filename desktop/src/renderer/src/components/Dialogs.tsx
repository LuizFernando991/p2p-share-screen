import { useState, type FormEvent, type ReactNode } from 'react'

import type { Room, RoomType } from '../../../shared/api'
import { api, errorMessage, messageFor } from '../lib/api'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Fechar">
            ✕
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
            <strong># Fixa</strong>
            <span className="muted small">Permanente. Você escolhe quem são os membros.</span>
          </label>
          <label className={`choice ${type === 'private' ? 'selected' : ''}`}>
            <input type="radio" checked={type === 'private'} onChange={() => setType('private')} />
            <strong>⏱ Temporária</strong>
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

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const res = await window.api.auth.changePassword(current, next)
    if (res.ok) setDone(true)
    else setError(messageFor(res.error.code, res.error.message))
  }

  return (
    <Modal title="Trocar senha" onClose={onClose}>
      {done ? (
        <div className="stack">
          <p>Senha alterada. As outras sessões da sua conta foram encerradas.</p>
          <button className="primary" onClick={onClose}>
            OK
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <label>
            Senha atual
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
          </label>
          <label>
            Nova senha
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary">Salvar</button>
        </form>
      )}
    </Modal>
  )
}
