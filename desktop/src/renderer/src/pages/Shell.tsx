import { Hash, KeyRound, LogOut, Plus, Settings, ShieldCheck, Timer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { Room, Session } from '../../../shared/api'
import { CreateRoomDialog, JoinCodeDialog, SettingsDialog } from '../components/Dialogs'
import { api, errorMessage } from '../lib/api'
import { AdminPage } from './AdminPage'
import { RoomPage } from './RoomPage'

type Dialog = 'create' | 'join' | 'settings' | null

export function Shell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const me = session.user
  const [rooms, setRooms] = useState<Room[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<'rooms' | 'admin'>('rooms')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setRooms(await api.rooms.list())
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  const room = rooms.find((r) => r.id === selected)

  function open(roomId: string) {
    setSelected(roomId)
    setView('rooms')
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span>Salas</span>
          <div className="row">
            <button className="icon" title="Entrar com código" onClick={() => setDialog('join')}>
              <KeyRound size={16} />
            </button>
            <button className="icon" title="Criar sala" onClick={() => setDialog('create')}>
              <Plus size={18} />
            </button>
          </div>
        </header>

        <nav className="room-list">
          {rooms.length === 0 && <p className="muted small pad">Nenhuma sala ainda. Crie uma ou entre com um código.</p>}
          {rooms.map((r) => (
            <button
              key={r.id}
              className={`room-item ${view === 'rooms' && r.id === selected ? 'active' : ''}`}
              onClick={() => open(r.id)}
            >
              <span className="room-icon">{r.temporary ? <Timer size={15} /> : <Hash size={15} />}</span>
              <span className="room-name">{r.name}</span>
              {r.live && r.live.publishers > 0 && (
                <span className="live-badge" title={`${r.live.participants} na sala`}>
                  AO VIVO
                </span>
              )}
            </button>
          ))}
        </nav>
        {error && <p className="error small pad">{error}</p>}

        <footer className="user-panel">
          <div className="avatar">{me.display_name.slice(0, 1).toUpperCase()}</div>
          <div className="user-names">
            <strong>{me.display_name}</strong>
            <span className="muted small">@{me.username}</span>
          </div>
          {me.role === 'admin' && (
            <button
              className={`icon ${view === 'admin' ? 'active' : ''}`}
              title="Usuários (admin)"
              aria-label="Usuários (admin)"
              onClick={() => setView(view === 'admin' ? 'rooms' : 'admin')}
            >
              <ShieldCheck size={16} />
            </button>
          )}
          <button className="icon" title="Configurações" onClick={() => setDialog('settings')}>
            <Settings size={16} />
          </button>
          <button className="icon" title="Sair" onClick={onLogout}>
            <LogOut size={16} />
          </button>
        </footer>
      </aside>

      <main className="content">
        {view === 'admin' ? (
          <AdminPage me={me} />
        ) : room ? (
          <RoomPage
            key={room.id}
            room={room}
            me={me}
            onChanged={refresh}
            onGone={() => {
              setSelected(null)
              void refresh()
            }}
          />
        ) : (
          <div className="empty">
            <h2>Bem-vindo, {me.display_name}</h2>
            <p className="muted">Escolha uma sala na lateral, crie uma nova ou entre com um código de convite.</p>
          </div>
        )}
      </main>

      {dialog === 'create' && (
        <CreateRoomDialog
          onClose={() => setDialog(null)}
          onCreated={(r) => {
            setDialog(null)
            void refresh().then(() => open(r.id))
          }}
        />
      )}
      {dialog === 'join' && (
        <JoinCodeDialog
          onClose={() => setDialog(null)}
          onJoined={(r) => {
            setDialog(null)
            void refresh().then(() => open(r.id))
          }}
        />
      )}
      {dialog === 'settings' && <SettingsDialog server={session.server} onClose={() => setDialog(null)} />}
    </div>
  )
}
