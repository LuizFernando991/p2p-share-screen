import { LiveKitRoom } from '@livekit/components-react'
import { Hash, LogOut, MoreHorizontal, Timer, Trash2, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'

import type { JoinToken, Room, User } from '../../../shared/api'
import { InviteDialog } from '../components/InviteDialog'
import { MembersPanel } from '../components/MembersPanel'
import { Stage } from '../components/Stage'
import { ConfirmDialog, Menu, useToast, type MenuItem } from '../components/ui'
import { api, errorMessage } from '../lib/api'

type Dialog = 'invite' | 'delete' | 'leave' | null

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
  const toast = useToast()
  const [join, setJoin] = useState<JoinToken | null>(null)
  const [showMembers, setShowMembers] = useState(room.can_manage && room.type === 'restricted' && room.member_count === 1)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [audioVolume, setAudioVolume] = useState(1)
  const [audioMuted, setAudioMuted] = useState(false)

  async function connect() {
    setError('')
    setConnecting(true)
    try {
      setJoin(await api.rooms.joinToken(room.id))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setConnecting(false)
    }
  }

  const isMember = room.my_role === 'member'
  const actions: MenuItem[] = [
    ...(isMember ? [{ label: 'Sair da sala', icon: <LogOut size={14} />, onSelect: () => setDialog('leave') }] : []),
    ...(room.can_manage
      ? [{ label: 'Apagar sala', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDialog('delete') }]
      : [])
  ]

  return (
    <div className="room-page">
      <header className="room-header">
        <span className="room-icon big">{room.temporary ? <Timer size={20} /> : <Hash size={20} />}</span>
        <h2>{room.name}</h2>
        <span className="badge" title={room.temporary ? 'Some quando fica vazia' : 'Permanente'}>
          {room.temporary ? 'Temporária' : 'Fixa'}
        </span>
        <div className="spacer" />
        {room.join_code && (
          <button className="ghost" onClick={() => setDialog('invite')} title="Convidar">
            <UserPlus size={16} /> <span className="label">Convidar</span>
          </button>
        )}
        <button className={`ghost ${showMembers ? 'active' : ''}`} onClick={() => setShowMembers(!showMembers)} title="Membros">
          <Users size={16} /> <span className="label">Membros</span>
          <span className="count">{room.member_count}</span>
        </button>
        {actions.length > 0 && <Menu label="Mais ações" trigger={<MoreHorizontal size={18} />} items={actions} />}
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
              // No adaptiveStream: the Stage picks layers by what the viewer watches.
              options={{ adaptiveStream: false, dynacast: true }}
              onDisconnected={() => {
                setJoin(null)
                onChanged()
              }}
              onError={(err) => setError(err.message)}
              className="lk-room"
            >
              <Stage
                roomName={join.room.name}
                canPublish={join.room.can_publish}
                audioVolume={audioVolume}
                audioMuted={audioMuted}
                onAudioVolumeChange={setAudioVolume}
                onAudioMutedChange={setAudioMuted}
              />
            </LiveKitRoom>
          ) : (
            <div className="lobby">
              <div className="lobby-icon">{room.temporary ? <Timer size={32} /> : <Hash size={32} />}</div>
              <h3>{room.name}</h3>
              <p className="muted">
                Dono(a): {room.owner.display_name} · {room.member_count}{' '}
                {room.member_count === 1 ? 'membro' : 'membros'}
              </p>
              {room.live && room.live.participants > 0 ? (
                <p className="live-line">
                  <span className="live-dot" /> {room.live.participants} na sala
                  {room.live.publishers > 0 &&
                    ` · ${room.live.publishers} compartilhando`}
                </p>
              ) : (
                <p className="muted">Ninguém na sala agora.</p>
              )}
              <button className="primary big" onClick={connect} disabled={connecting}>
                {connecting ? 'Entrando…' : 'Entrar na sala'}
              </button>
            </div>
          )}
        </section>
        {showMembers && <MembersPanel room={room} me={me} onChanged={onChanged} onClose={() => setShowMembers(false)} />}
      </div>

      {dialog === 'invite' && <InviteDialog room={room} onChanged={onChanged} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog
          title="Apagar sala"
          message={
            <p>
              Apagar <strong>“{room.name}”</strong> para todos? Quem estiver na chamada é desconectado e a sala não pode
              ser recuperada.
            </p>
          }
          confirmLabel="Apagar sala"
          danger
          onConfirm={async () => {
            await api.rooms.remove(room.id)
            toast(`Sala “${room.name}” apagada`)
            onGone()
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'leave' && (
        <ConfirmDialog
          title="Sair da sala"
          message={
            <p>
              Sair de <strong>“{room.name}”</strong>?{' '}
              Para voltar, você vai precisar do código de convite.
            </p>
          }
          confirmLabel="Sair da sala"
          danger
          onConfirm={async () => {
            await api.rooms.removeMember(room.id, me.id)
            toast(`Você saiu de “${room.name}”`)
            onGone()
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}
