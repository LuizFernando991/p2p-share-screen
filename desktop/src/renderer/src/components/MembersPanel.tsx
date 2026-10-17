import { Crown, MonitorUp, MoreHorizontal, Search, UserMinus, UserPlus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { DirectoryUser, Member, Room, User } from '../../../shared/api'
import { api, errorMessage } from '../lib/api'
import { ConfirmDialog, Menu, useToast } from './ui'

type Pending = { kind: 'transfer' | 'remove'; member: Member } | null

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
  const toast = useToast()
  const [members, setMembers] = useState<Member[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DirectoryUser[] | null>(null)
  const [pending, setPending] = useState<Pending>(null)
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
  }, [load, room.member_count, room.owner.id])

  const canAdd = room.can_manage && room.type === 'restricted'
  useEffect(() => {
    if (!canAdd || query.trim().length < 2) {
      setResults(null)
      return
    }
    const timer = setTimeout(() => {
      void api.users.directory(query).then(setResults, () => setResults([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [query, canAdd])

  async function refreshAfter(action: () => Promise<unknown>, notice: string) {
    await action()
    await load()
    onChanged()
    toast(notice)
  }

  async function add(user: DirectoryUser) {
    setError('')
    try {
      await refreshAfter(() => api.rooms.addMember(room.id, user.id, true), `${user.display_name} entrou na sala`)
      setQuery('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function togglePublish(m: Member) {
    setError('')
    try {
      await refreshAfter(
        () => api.rooms.setCanPublish(room.id, m.user_id, !m.can_publish),
        m.can_publish ? `${m.display_name} agora só assiste` : `${m.display_name} pode compartilhar a tela`
      )
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const memberIds = new Set(members.map((m) => m.user_id))
  const candidates = results?.filter((u) => !memberIds.has(u.id)) ?? []

  return (
    <aside className="members-panel">
      <header className="panel-header">
        <strong>Membros · {members.length}</strong>
        <button className="icon" onClick={onClose} aria-label="Fechar painel" title="Fechar">
          <X size={16} />
        </button>
      </header>

      {canAdd && (
        <div className="add-member">
          <div className="input-icon">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar pessoa…" />
          </div>
          {results && candidates.length === 0 && (
            <p className="muted small hint">
              {results.length === 0 ? 'Ninguém encontrado.' : 'Todos com esse nome já estão na sala.'}
            </p>
          )}
          {candidates.map((u) => (
            <button key={u.id} className="candidate" onClick={() => add(u)}>
              <div className="avatar small">{u.display_name.slice(0, 1).toUpperCase()}</div>
              <span className="candidate-names">
                <span>{u.display_name}</span>
                <span className="muted small">@{u.username}</span>
              </span>
              <UserPlus size={16} className="candidate-add" />
            </button>
          ))}
        </div>
      )}
      {room.can_manage && room.type === 'private' && (
        <p className="muted small hint pad">Sala temporária: entra quem tiver o código de convite.</p>
      )}

      {error && <p className="error small pad">{error}</p>}

      <ul className="member-list">
        {members.map((m) => {
          const isMe = m.user_id === me.id
          const manageable = room.can_manage && m.role !== 'owner' && !isMe
          return (
            <li key={m.user_id} className={m.disabled ? 'disabled' : ''}>
              <div className="avatar small">{m.display_name.slice(0, 1).toUpperCase()}</div>
              <div className="member-names">
                <span className="member-name">
                  {m.display_name}
                  {isMe && <span className="muted"> (você)</span>}
                </span>
                <span className="member-role">
                  {m.role === 'owner' ? (
                    <span className="pill owner">
                      <Crown size={11} /> Dono da sala
                    </span>
                  ) : m.can_publish ? (
                    <span className="pill">Pode compartilhar</span>
                  ) : (
                    <span className="pill subtle">Só assiste</span>
                  )}
                </span>
              </div>
              {manageable && (
                <Menu
                  label={`Opções de ${m.display_name}`}
                  trigger={<MoreHorizontal size={16} />}
                  items={[
                    {
                      label: 'Pode compartilhar a tela',
                      icon: <MonitorUp size={14} />,
                      checked: m.can_publish,
                      onSelect: () => void togglePublish(m)
                    },
                    ...(room.type === 'restricted'
                      ? [
                          {
                            label: 'Transferir posse da sala',
                            icon: <Crown size={14} />,
                            onSelect: () => setPending({ kind: 'transfer', member: m })
                          }
                        ]
                      : []),
                    {
                      label: 'Remover da sala',
                      icon: <UserMinus size={14} />,
                      danger: true,
                      onSelect: () => setPending({ kind: 'remove', member: m })
                    }
                  ]}
                />
              )}
            </li>
          )
        })}
      </ul>

      {pending?.kind === 'transfer' && (
        <ConfirmDialog
          title="Transferir posse da sala"
          message={
            <>
              <p>
                <strong>{pending.member.display_name}</strong> passa a ser dono(a) de “{room.name}” e poderá gerenciar
                membros e apagar a sala.
              </p>
              <p className="muted">
                {room.owner.id === me.id
                  ? 'Você continua na sala como membro e pode compartilhar a tela.'
                  : `${room.owner.display_name} continua na sala como membro.`}
              </p>
            </>
          }
          confirmLabel="Transferir posse"
          onConfirm={() =>
            refreshAfter(
              () => api.rooms.transfer(room.id, pending.member.user_id),
              `Posse transferida para ${pending.member.display_name}`
            )
          }
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'remove' && (
        <ConfirmDialog
          title="Remover da sala"
          message={
            <p>
              Remover <strong>{pending.member.display_name}</strong> de “{room.name}”? Se estiver conectado(a), sai da
              chamada na hora.
            </p>
          }
          confirmLabel="Remover"
          danger
          onConfirm={() =>
            refreshAfter(
              () => api.rooms.removeMember(room.id, pending.member.user_id),
              `${pending.member.display_name} foi removido(a) da sala`
            )
          }
          onClose={() => setPending(null)}
        />
      )}
    </aside>
  )
}
