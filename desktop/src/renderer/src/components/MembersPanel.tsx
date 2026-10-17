import { useCallback, useEffect, useState } from 'react'

import type { DirectoryUser, Member, Room, User } from '../../../shared/api'
import { api, errorMessage } from '../lib/api'

export function MembersPanel({
  room,
  me,
  onChanged,
  onClose
}: {
  room: Room
  me: User
  onChanged: () => void
  onClose: () => void
}) {
  const [members, setMembers] = useState<Member[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DirectoryUser[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setMembers(await api.rooms.members(room.id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [room.id])

  useEffect(() => {
    void load()
  }, [load, room.member_count])

  useEffect(() => {
    if (!room.can_manage || query.trim().length < 2) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      void api.users.directory(query).then(setResults, () => setResults([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [query, room.can_manage])

  async function act(action: () => Promise<unknown>) {
    setError('')
    try {
      await action()
      await load()
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const memberIds = new Set(members.map((m) => m.user_id))
  const candidates = results.filter((u) => !memberIds.has(u.id))

  return (
    <aside className="members-panel">
      <header className="panel-header">
        <strong>Membros</strong>
        <button className="icon" onClick={onClose} aria-label="Fechar">
          ✕
        </button>
      </header>

      {room.can_manage && room.type === 'restricted' && (
        <div className="add-member">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Adicionar pessoa…" />
          {candidates.map((u) => (
            <button
              key={u.id}
              className="candidate"
              onClick={() => act(() => api.rooms.addMember(room.id, u.id, true)).then(() => setQuery(''))}
            >
              <strong>{u.display_name}</strong> <span className="muted small">@{u.username}</span>
            </button>
          ))}
        </div>
      )}
      {room.can_manage && room.type === 'private' && (
        <p className="muted small pad">Quem tiver o código entra na sala.</p>
      )}

      {error && <p className="error small pad">{error}</p>}

      <ul className="member-list">
        {members.map((m) => (
          <li key={m.user_id} className={m.disabled ? 'disabled' : ''}>
            <div className="avatar small">{m.display_name.slice(0, 1).toUpperCase()}</div>
            <div className="member-names">
              <span>
                {m.display_name}
                {m.user_id === me.id && ' (você)'}
              </span>
              <span className="muted small">{m.role === 'owner' ? 'Dono' : m.can_publish ? 'Pode compartilhar' : 'Só assiste'}</span>
            </div>
            {room.can_manage && m.role !== 'owner' && (
              <div className="member-actions">
                <label className="toggle small" title="Pode compartilhar a tela">
                  <input
                    type="checkbox"
                    checked={m.can_publish}
                    onChange={(e) => act(() => api.rooms.setCanPublish(room.id, m.user_id, e.target.checked))}
                  />
                  Tela
                </label>
                {room.type === 'restricted' && (
                  <button className="link" onClick={() => act(() => api.rooms.transfer(room.id, m.user_id))}>
                    tornar dono
                  </button>
                )}
                <button className="link danger" onClick={() => act(() => api.rooms.removeMember(room.id, m.user_id))}>
                  remover
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}
