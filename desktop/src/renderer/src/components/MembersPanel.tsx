import { AtSign, Crown, MonitorUp, MoreHorizontal, UserMinus, UserPlus, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

import type { Member, Room, User } from '../../../shared/api'
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
  const [username, setUsername] = useState('')
  const [adding, setAdding] = useState(false)
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

  async function refreshAfter(action: () => Promise<unknown>, notice: string) {
    await action()
    await load()
    onChanged()
    toast(notice)
  }

  // Exact username only: there is no user search, so nobody can list who
  // has an account.
  async function add(e: FormEvent) {
    e.preventDefault()
    const name = username.trim()
    if (!name) return
    setError('')
    setAdding(true)
    try {
      const added = await api.rooms.addMember(room.id, name, true)
      setUsername('')
      await load()
      onChanged()
      toast(`${added.display_name} entrou na sala`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setAdding(false)
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

  return (
    <aside className="members-panel">
      <header className="panel-header">
        <strong>Membros · {members.length}</strong>
        <button className="icon" onClick={onClose} aria-label="Fechar painel" title="Fechar">
          <X size={16} />
        </button>
      </header>

      {room.can_manage && (
        <form className="add-member" onSubmit={add}>
          <div className="add-member-row">
            <div className="input-icon">
              <AtSign size={14} />
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username da pessoa"
                aria-label="Username da pessoa"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button className="icon" disabled={adding || !username.trim()} title="Adicionar" aria-label="Adicionar">
              <UserPlus size={16} />
            </button>
          </div>
          <p className="muted small hint">Digite o username exato ou envie o código de convite da sala.</p>
        </form>
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
