import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react'
import { useState } from 'react'

import type { JoinToken, Room, User } from '../../../shared/api'
import { MembersPanel } from '../components/MembersPanel'
import { Stage } from '../components/Stage'
import { api, errorMessage } from '../lib/api'

export function RoomPage({
  room,
  me,
  onChanged,
  onGone
}: {
  room: Room
  me: User
  onChanged: () => void
  /** The room was deleted or the user left it. */
  onGone: () => void
}) {
  const [join, setJoin] = useState<JoinToken | null>(null)
  const [showMembers, setShowMembers] = useState(room.can_manage && room.type === 'restricted' && room.member_count === 1)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function connect() {
    setError('')
    try {
      setJoin(await api.rooms.joinToken(room.id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function act(action: () => Promise<unknown>, after?: () => void) {
    setError('')
    try {
      await action()
      after?.()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function copyCode() {
    if (!room.join_code) return
    await navigator.clipboard.writeText(room.join_code)
    setNotice('Código copiado')
    setTimeout(() => setNotice(''), 2000)
  }

  return (
    <div className="room-page">
      <header className="room-header">
        <span className="room-icon big">{room.temporary ? '⏱' : '#'}</span>
        <h2>{room.name}</h2>
        <span className="badge">{room.temporary ? 'Temporária' : 'Fixa'}</span>
        {room.join_code && (
          <span className="invite">
            Código: <code>{room.join_code}</code>
            <button className="link" onClick={copyCode}>
              copiar
            </button>
            <button className="link" onClick={() => act(() => api.rooms.regenerateCode(room.id), onChanged)}>
              gerar outro
            </button>
          </span>
        )}
        {notice && <span className="notice">{notice}</span>}
        <div className="spacer" />
        <button className={`ghost ${showMembers ? 'active' : ''}`} onClick={() => setShowMembers(!showMembers)}>
          Membros ({room.member_count})
        </button>
        {room.can_manage ? (
          <button
            className="ghost danger"
            onBlur={() => setConfirmDelete(false)}
            onClick={() =>
              confirmDelete ? act(() => api.rooms.remove(room.id), onGone) : setConfirmDelete(true)
            }
          >
            {confirmDelete ? 'Confirmar exclusão' : 'Apagar sala'}
          </button>
        ) : (
          <button className="ghost" onClick={() => act(() => api.rooms.removeMember(room.id, me.id), onGone)}>
            Sair da sala
          </button>
        )}
      </header>
      {error && <p className="error pad">{error}</p>}

      <div className="room-body">
        <section className="room-main">
          {join ? (
            <LiveKitRoom
              serverUrl={join.livekit_url}
              token={join.token}
              connect
              audio={false}
              video={false}
              options={{ adaptiveStream: true, dynacast: true }}
              onDisconnected={() => {
                setJoin(null)
                onChanged()
              }}
              onError={(err) => setError(err.message)}
              className="lk-room"
            >
              <Stage canPublish={join.room.can_publish} />
              <RoomAudioRenderer />
            </LiveKitRoom>
          ) : (
            <div className="lobby">
              <h3>{room.name}</h3>
              <p className="muted">
                Dono: {room.owner.display_name} · {room.member_count} {room.member_count === 1 ? 'membro' : 'membros'}
              </p>
              {room.live && room.live.participants > 0 ? (
                <p>
                  <span className="live-dot" /> {room.live.participants} na sala
                  {room.live.publishers > 0 && `, ${room.live.publishers} compartilhando`}
                </p>
              ) : (
                <p className="muted">Ninguém na sala agora.</p>
              )}
              <button className="primary big" onClick={connect}>
                Entrar na sala
              </button>
            </div>
          )}
        </section>
        {showMembers && <MembersPanel room={room} me={me} onChanged={onChanged} onClose={() => setShowMembers(false)} />}
      </div>
    </div>
  )
}
