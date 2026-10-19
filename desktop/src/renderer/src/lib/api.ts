import type {
  DesktopApi,
  HttpMethod,
  JoinToken,
  Member,
  Role,
  Room,
  RoomType,
  User
} from '../../../shared/api'

declare global {
  interface Window {
    api: DesktopApi
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const res = await window.api.request<T>(method, path, body)
  if (res.ok) return res.data
  throw new ApiError(res.error.status, res.error.code, res.error.message)
}

export const api = {
  rooms: {
    list: () => call<{ rooms: Room[] }>('GET', '/api/rooms').then((r) => r.rooms),
    create: (name: string, type: RoomType) => call<Room>('POST', '/api/rooms', { name, type }),
    rename: (id: string, name: string) => call<Room>('PATCH', `/api/rooms/${id}`, { name }),
    remove: (id: string) => call<null>('DELETE', `/api/rooms/${id}`),
    joinByCode: (code: string) => call<Room>('POST', '/api/rooms/join-by-code', { code }),
    regenerateCode: (id: string) => call<Room>('POST', `/api/rooms/${id}/code/regenerate`),
    transfer: (id: string, userId: string) => call<Room>('POST', `/api/rooms/${id}/owner`, { user_id: userId }),
    joinToken: (id: string) => call<JoinToken>('POST', `/api/rooms/${id}/join-token`),
    members: (id: string) => call<{ members: Member[] }>('GET', `/api/rooms/${id}/members`).then((r) => r.members),
    addMember: (id: string, username: string, canPublish: boolean) =>
      call<Member>('POST', `/api/rooms/${id}/members`, { username, can_publish: canPublish }),
    setCanPublish: (id: string, userId: string, canPublish: boolean) =>
      call<Member>('PATCH', `/api/rooms/${id}/members/${userId}`, { can_publish: canPublish }),
    removeMember: (id: string, userId: string) => call<null>('DELETE', `/api/rooms/${id}/members/${userId}`)
  },
  users: {
    list: () => call<{ users: User[] }>('GET', '/api/admin/users').then((r) => r.users),
    create: (input: { username: string; display_name: string; password: string; role: Role }) =>
      call<User>('POST', '/api/admin/users', input),
    update: (id: string, patch: { display_name?: string; role?: Role; disabled?: boolean; password?: string }) =>
      call<User>('PATCH', `/api/admin/users/${id}`, patch),
    remove: (id: string) => call<null>('DELETE', `/api/admin/users/${id}`)
  }
}

const messages: Record<string, string> = {
  network_error: 'Não foi possível conectar ao servidor.',
  invalid_server: 'URL do servidor inválida (ex.: https://share.exemplo.com).',
  not_logged_in: 'Sua sessão expirou. Entre novamente.',
  invalid_credentials: 'Usuário ou senha inválidos.',
  account_disabled: 'Esta conta está desativada.',
  too_many_requests: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  wrong_password: 'A senha atual está incorreta.',
  weak_password: 'A senha precisa ter pelo menos 8 caracteres.',
  invalid_username: 'Usuário inválido: de 3 a 32 caracteres, com letras, números, ".", "_" ou "-".',
  username_taken: 'Esse usuário já existe.',
  cannot_modify_self: 'Você não pode rebaixar, desativar ou apagar a própria conta.',
  room_not_found: 'Sala não encontrada.',
  not_room_owner: 'Só o dono da sala pode fazer isso.',
  invalid_room_name: 'O nome da sala precisa ter de 1 a 64 caracteres.',
  invalid_join_code: 'Nenhuma sala tem esse código.',
  user_not_found: 'Nenhum usuário com esse nome. Confira o username exato.',
  already_member: 'Essa pessoa já é membro da sala.',
  member_not_found: 'Essa pessoa não é membro da sala.',
  user_disabled: 'Esse usuário está desativado.',
  owner_must_transfer: 'Passe a posse da sala para outro membro antes de sair.',
  owner_cannot_leave: 'O dono de uma sala temporária não pode sair. Apague a sala.',
  cannot_modify_owner: 'As permissões do dono não podem ser alteradas.'
}

export function messageFor(code: string, fallback: string): string {
  return messages[code] ?? fallback
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return messageFor(err.code, err.message)
  if (err instanceof Error) return err.message
  return String(err)
}
