import { useCallback, useEffect, useState, type FormEvent } from 'react'

import type { Role, User } from '../../../shared/api'
import { api, errorMessage } from '../lib/api'

export function AdminPage({ me }: { me: User }) {
  const [users, setUsers] = useState<User[]>([])
  const [error, setError] = useState('')
  const [form, setForm] = useState({ username: '', display_name: '', password: '', role: 'user' as Role })
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setUsers(await api.users.list())
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(action: () => Promise<unknown>) {
    setError('')
    try {
      await action()
      await load()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    if (await act(() => api.users.create(form))) setForm({ username: '', display_name: '', password: '', role: 'user' })
  }

  async function resetPassword(e: FormEvent, user: User) {
    e.preventDefault()
    if (await act(() => api.users.update(user.id, { password: newPassword }))) {
      setResetFor(null)
      setNewPassword('')
    }
  }

  return (
    <div className="admin">
      <h2>Usuários</h2>
      <p className="muted">Só quem estiver aqui consegue entrar no app.</p>

      <form className="card create-user" onSubmit={create}>
        <input
          placeholder="usuário"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          required
        />
        <input
          placeholder="nome de exibição"
          value={form.display_name}
          onChange={(e) => setForm({ ...form, display_name: e.target.value })}
        />
        <input
          placeholder="senha inicial"
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          minLength={8}
          required
        />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
          <option value="user">Usuário</option>
          <option value="admin">Admin</option>
        </select>
        <button className="primary">Criar usuário</button>
      </form>
      {error && <p className="error">{error}</p>}

      <table className="users">
        <thead>
          <tr>
            <th>Nome</th>
            <th>Usuário</th>
            <th>Papel</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.disabled ? 'disabled' : ''}>
              <td>{u.display_name}</td>
              <td className="muted">@{u.username}</td>
              <td>{u.role === 'admin' ? 'Admin' : 'Usuário'}</td>
              <td>{u.disabled ? 'Desativado' : 'Ativo'}</td>
              <td className="actions">
                {resetFor === u.id ? (
                  <form className="row" onSubmit={(e) => resetPassword(e, u)}>
                    <input
                      type="password"
                      placeholder="nova senha"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      minLength={8}
                      required
                      autoFocus
                    />
                    <button className="primary small">Salvar</button>
                    <button type="button" className="link" onClick={() => setResetFor(null)}>
                      cancelar
                    </button>
                  </form>
                ) : (
                  <>
                    <button className="link" onClick={() => setResetFor(u.id)}>
                      resetar senha
                    </button>
                    {u.id !== me.id && (
                      <>
                        <button className="link" onClick={() => act(() => api.users.update(u.id, { disabled: !u.disabled }))}>
                          {u.disabled ? 'ativar' : 'desativar'}
                        </button>
                        <button
                          className="link"
                          onClick={() => act(() => api.users.update(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }))}
                        >
                          {u.role === 'admin' ? 'tirar admin' : 'tornar admin'}
                        </button>
                        <button
                          className="link danger"
                          onBlur={() => setConfirmDelete(null)}
                          onClick={() =>
                            confirmDelete === u.id ? act(() => api.users.remove(u.id)) : setConfirmDelete(u.id)
                          }
                        >
                          {confirmDelete === u.id ? 'confirmar exclusão' : 'apagar'}
                        </button>
                      </>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
