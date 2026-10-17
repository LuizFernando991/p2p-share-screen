# p2p-share-screen

App desktop (Windows e Linux) de compartilhamento de tela em salas, com acesso controlado: só entra quem o admin cadastrou.

## Arquitetura

```
┌──────────────────────┐   HTTPS (REST)    ┌──────────────────────┐
│ desktop/ (Electron)  │ ────────────────► │ backend/ (Go)        │
│ React + TypeScript   │   login, salas,   │ auth, usuários,      │
│                      │   token LiveKit   │ salas, permissões    │
│                      │                   │ SQLite               │
│                      │                   └──────────┬───────────┘
│                      │                     webhooks │ ▲ API admin
│                      │   WebRTC (mídia)  ┌──────────▼─┴─────────┐
│                      │ ◄───────────────► │ LiveKit (SFU)        │
└──────────────────────┘   via TURN/UDP    │ self-hosted, TURN    │
                                           │ embutido             │
                                           └──────────────────────┘
```

- **O backend Go não toca em mídia.** Ele autentica, decide quem pode entrar em qual sala e emite um **token LiveKit** (JWT) com as permissões certas (`roomJoin`, `canPublish`, `canSubscribe`). O cliente conecta direto no LiveKit com esse token.
- **LiveKit** é o SFU: quem transmite envia o stream uma vez e o servidor redistribui para 5–50 espectadores. O TURN embutido do LiveKit resolve NAT/firewall na internet.
- Várias pessoas podem transmitir na mesma sala ao mesmo tempo; o espectador escolhe qual tela assistir.

## Estrutura do repositório

```
backend/            # Go: API REST
  cmd/server/       # main: servidor HTTP + subcomandos (ex.: criar admin)
  internal/
    auth/           # hash de senha, JWT de acesso, refresh tokens, middleware
    users/          # CRUD de usuários (somente admin)
    rooms/          # salas, membros, códigos de convite, TODAS as regras de acesso a sala
    livekit/        # implementa rooms.Media: token LiveKit, webhook, RoomService API
    httpapi/        # roteamento, handlers, erros, JSON
    store/          # acesso ao SQLite: todo SQL do projeto fica aqui
    config/         # config via variáveis de ambiente
    apperr/         # erros de domínio com código estável → status HTTP
    id/             # geração de UUIDv7
    testutil/       # helpers de teste (banco temporário)
  migrations/       # migrations SQL (goose), embutidas no binário
desktop/            # Electron + React + TS (main / preload / renderer)
deploy/             # docker-compose.yml + livekit.dev.yaml (LiveKit local de dev); produção: pendente
```

## Stack do backend

- **Go** (versão estável mais recente), roteamento com `net/http` da stdlib (padrões `GET /rooms/{id}`), sem framework.
- **SQLite** via `modernc.org/sqlite` (Go puro, sem CGO: cross-compile simples). Abrir com `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout`.
- **SQL escrito à mão** com `database/sql` em `internal/store` (o tipo `Queries` funciona tanto no `*sql.DB` quanto numa transação via `Store.WithTx`). As transações usam `_txlock=immediate`, então não há deadlock em ler-e-depois-escrever.
- **goose** como biblioteca: as migrations em `migrations/*.sql` vão embutidas no binário (`embed`) e são aplicadas no `store.Open`. Nunca editar uma migration já aplicada; sempre criar uma nova (`00002_rooms.sql`...).
- Datas no SQLite em TEXT com largura fixa (`2006-01-02T15:04:05.000000000Z`), para que a comparação de strings no SQL funcione.
- **Senhas:** argon2id (`golang.org/x/crypto/argon2`).
- **Tokens LiveKit:** `github.com/livekit/protocol/auth`; webhooks com `github.com/livekit/protocol/webhook`.
- **Logs:** `log/slog` em JSON.
- **Testes:** `go test ./...` com `httptest` e SQLite em memória/tempfile. Toda regra de permissão de sala tem que ter teste.

## Domínio

### Usuários e autenticação
- **Sem cadastro público.** Só o admin cria usuários (username, nome de exibição, senha inicial, papel).
- Papéis: `admin` | `user`. O admin também pode desativar usuários (`disabled`): o login falha e os refresh tokens são revogados.
- O primeiro admin é criado por subcomando: `server admin create --username X` (pede a senha no terminal). Não existe admin padrão com senha fixa.
- Login retorna:
  - **access token** JWT (HS256, ~15 min) com `sub`. A cada requisição o middleware recarrega o usuário do banco, então desativar a conta ou trocar o papel vale na hora;
  - **refresh token** opaco e aleatório. No banco fica só o hash SHA-256. É rotacionado a cada uso; se um token já usado for reapresentado, toda a família é revogada.
- No desktop, o refresh token fica no keychain do SO, nunca em `localStorage`. O cliente precisa **serializar** as chamadas de refresh: dois refresh simultâneos com o mesmo token contam como reuso e derrubam a sessão.
- Trocar a própria senha (`PATCH /api/me/password`) encerra todas as sessões e devolve um par novo. O reset de senha ou a desativação feitos pelo admin também encerram as sessões.
- O admin não pode se rebaixar, se desativar nem se apagar. Isso garante que sempre exista pelo menos um admin.
- Login tem rate limit por IP (rajada de 10, depois 1 a cada 6 s). Atrás de proxy reverso, usar `APP_TRUST_PROXY=true`.

### Salas
Qualquer usuário logado pode criar uma sala e vira o **dono**. Há dois tipos:

| Tipo | Duração | Como se entra | Dono pode sair? |
|---|---|---|---|
| `restricted` (**fixa**) | Permanente | Lista de membros, definida pelo dono | Sim, depois de **transferir a posse** para outro membro (`POST /api/rooms/{id}/owner`) |
| `private` (**temporária**) | Apagada depois de ficar **vazia** (ninguém conectado no LiveKit) por `APP_TEMP_ROOM_GRACE` (padrão 5 min) | Quem tiver o **código** | Não: ele apaga a sala, ou ela acaba sozinha ao esvaziar |

- Toda regra de permissão fica em `internal/rooms` (`authorize`, `CanManage`, `CanPublish`).
- Membros (`room_members`): `role` = `owner` | `member`, mais a flag `can_publish` (se pode transmitir; padrão `true`). O dono também é uma linha em `room_members` e sempre pode transmitir.
- Numa sala fixa, os membros entram e transmitem a qualquer hora, mesmo com o dono offline.
- Só o dono (ou o admin) adiciona/remove membros, muda `can_publish`, renomeia, apaga e regenera o código. Um membro pode sair por conta própria (`DELETE /members/{seu id}`).
- Entrar com código válido adiciona o usuário como membro (ele volta sem o código). Regenerar o código não remove quem já entrou. O código só aparece na resposta para o dono e o admin.
- Sala temporária: a coluna `rooms.empty_since` marca desde quando ela está vazia (começa preenchida na criação). Os webhooks do LiveKit limpam essa coluna quando alguém entra e a preenchem quando a sala fecha (ver "Fluxo para entrar e transmitir"). A rotina `cleanupLoop` (a cada 1 min) apaga as que passaram do prazo.
- Apagar um usuário apaga as salas de que ele é dono (cascade).
- O admin enxerga e gerencia qualquer sala.
- Código de convite: 8 caracteres de um alfabeto de 32 símbolos sem `0/1/I/O`, exibido como `K7QF-2MXP`, gerado com `crypto/rand`. A entrada aceita minúsculas, com ou sem hífen. Tentativas têm rate limit por usuário.
- Para o dono achar quem adicionar, `GET /api/users?q=` busca usuários ativos (só id, username e nome).
- O nome da sala no LiveKit é o `id` da sala no nosso banco.

### Fluxo para entrar e transmitir (LiveKit)
`internal/rooms` define a interface `Media`; `internal/livekit` a implementa (tokens, RoomService via Twirp, webhooks). Testes de `rooms` usam um `fakeMedia`; os de `httpapi` usam o cliente real apontando para uma porta fechada.

1. Cliente: `POST /api/rooms/{id}/join-token` → `{livekit_url, token, room}`.
2. Backend checa acesso (membro, dono ou admin) e gera um token LiveKit: `roomJoin` na sala `id`, `canSubscribe=true`, `canPublish` conforme `rooms.CanPublish`, `canPublishSources=[screen_share, screen_share_audio]` (**sem câmera/microfone**), `canPublishData=true`, identity = user id, name = nome de exibição, TTL `LIVEKIT_TOKEN_TTL` (padrão 10 min; depois de conectado, o LiveKit renova o token sozinho). Em sala temporária, pedir token também reinicia o prazo do `empty_since`.
3. Cliente conecta direto no LiveKit e publica/assina as faixas.
4. `GET /api/rooms` e `GET /api/rooms/{id}` trazem `live: {participants, publishers}` consultando o `ListRooms` do LiveKit (uma chamada para a lista toda). Se o LiveKit estiver fora, o campo `live` não aparece e o resto funciona.
5. Webhook `POST /api/livekit/webhook`: a assinatura JWT e o sha256 do corpo são verificados. `room_started`/`participant_joined` limpam o `empty_since`; `room_finished` (o LiveKit fecha a sala ~20 s depois que o último sai) o preenche.
6. A limpeza de salas temporárias confere no LiveKit antes de apagar: se ainda há alguém conectado (webhook perdido ou fora de ordem), ela só limpa o `empty_since`. Se o LiveKit não responde, não apaga nada.
7. Derrubar conexões (best effort, depois do commit; falha vira log WARN): remover membro → `RemoveParticipant`; tirar `can_publish` → `UpdateParticipant` (encerra a transmissão em curso); apagar sala → `DeleteRoom`; desativar usuário ou resetar senha → `RemoveParticipant` em todas as salas em que ele é membro; apagar usuário → `DeleteRoom` nas salas dele e `RemoveParticipant` nas demais.
- Limitações conhecidas: identity = user id, então o mesmo usuário em dois aparelhos derruba a primeira conexão. Um admin conectado numa sala da qual não é membro não é derrubado ao ser desativado.

## API (rascunho)

```
POST   /api/auth/login                 {username, password} → {access_token, refresh_token}
POST   /api/auth/refresh               {refresh_token} → novo par
POST   /api/auth/logout                revoga o refresh token
GET    /api/me
PATCH  /api/me/password

# admin
GET    /api/admin/users
POST   /api/admin/users                {username, display_name?, password, role?}
GET    /api/admin/users/{id}
PATCH  /api/admin/users/{id}           {display_name?, role?, disabled?, password?}
DELETE /api/admin/users/{id}

GET    /api/users?q=                   busca de usuários ativos (qualquer logado)

# salas
GET    /api/rooms                      salas em que sou membro/dono (admin: todas)
POST   /api/rooms                      {name, type: restricted|private}
GET    /api/rooms/{id}
PATCH  /api/rooms/{id}                 dono/admin: {name}
DELETE /api/rooms/{id}                 dono/admin
POST   /api/rooms/{id}/code/regenerate dono/admin (só private)
POST   /api/rooms/{id}/owner           dono/admin: {user_id} (só restricted; alvo precisa ser membro)
POST   /api/rooms/join-by-code         {code}
GET    /api/rooms/{id}/members
POST   /api/rooms/{id}/members         dono/admin: {user_id, can_publish?}
PATCH  /api/rooms/{id}/members/{uid}   dono/admin: {can_publish}
DELETE /api/rooms/{id}/members/{uid}   dono/admin, ou o próprio membro saindo
POST   /api/rooms/{id}/join-token      (fase 3) → {livekit_url, token}

POST   /api/livekit/webhook
GET    /healthz
```

Erros sempre no formato `{"error": {"code": "room_not_found", "message": "..."}}`. Para não vazar a existência de recursos, quem não tem acesso a uma sala recebe 404, não 403.

## Convenções

- Identificadores, código e mensagens de commit em inglês; documentação e conversa em português.
- IDs são UUIDv7 (ordenáveis), salvos como TEXT. Datas em UTC, RFC 3339.
- Toda checagem de permissão fica em `internal/rooms` (ou `auth`), nunca espalhada nos handlers. Handler fino: decodifica, chama o serviço, serializa.
- Config só por variáveis de ambiente (`APP_ADDR`, `APP_DB_PATH`, `APP_JWT_SECRET`, `APP_ACCESS_TTL`, `APP_REFRESH_TTL`, `APP_TRUST_PROXY`, `APP_TEMP_ROOM_GRACE`, `LIVEKIT_URL` (ws/wss, obrigatório), `LIVEKIT_API_URL` (opcional), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_TOKEN_TTL`). Segredos nunca entram no repo; `backend/.env.example` documenta as variáveis.
- Serviços retornam `*apperr.Error` para erros esperados (o código vira o `error.code` da resposta); qualquer outro erro vira 500 genérico e é logado. Erros de `store` (`ErrNotFound`, `ErrConflict`) são traduzidos para `apperr` no serviço.
- Testes usam `auth.FastPasswordParams` (argon2 barato) e `testutil.OpenStore` (banco em diretório temporário).
- `context.Context` em toda função que faz I/O.

## Comandos

```bash
# backend
cd backend && APP_JWT_SECRET=$(openssl rand -base64 48) go run ./cmd/server   # sobe a API (migrations automáticas)
cd backend && go run ./cmd/server admin create --username admin             # pede a senha; ou: echo "senha" | ...
cd backend && go test -race ./...
cd backend && go vet ./... && gofmt -l .

# infra local: LiveKit v1.13.10 em :7880, webhooks para o backend em host.docker.internal:8080
docker compose -f deploy/docker-compose.yml up -d
# backend apontando para ele (valores de backend/.env.example)
cd backend && APP_JWT_SECRET=$(openssl rand -base64 48) LIVEKIT_URL=ws://localhost:7880 \
  LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=dev-secret-change-me-dev-secret-change-me go run ./cmd/server
# participante de teste (sem app): entra na sala <room-id> e dispara os webhooks
docker run --rm --network host livekit/livekit-cli room join --url ws://127.0.0.1:7880 \
  --api-key devkey --api-secret dev-secret-change-me-dev-secret-change-me --identity tester <room-id>
```

## Desktop (Electron)

**Decisão:** Electron + React + TypeScript + `livekit-client`, o mesmo modelo do Discord: Chromium com WebRTC completo, então capturar, publicar, assistir, qualidade adaptativa e simulcast vêm do `livekit-client`. Começamos com Tauri, mas o WebKitGTK do Ubuntu não tem WebRTC (ver "Histórico do spike").

- **Stack:** `electron-vite` 5 (com Vite 7.3; o electron-vite 5 não aceita Vite 8), React 19, TypeScript 6, `livekit-client`, empacotamento com `electron-builder` (deb, AppImage, NSIS). Gerenciador: npm.
- **Processos:**
  - **main** (Node): janela, toda a comunicação com o backend, credenciais, captura de tela (handler de display media), áudio do sistema no Linux (venmic).
  - **preload**: expõe uma API mínima e tipada via `contextBridge` (`window.api`).
  - **renderer** (React): UI e mídia (`livekit-client`). `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP restritiva.
- **Backend só pelo main:** o renderer chama `window.api.*` via IPC, e o main faz o fetch. Assim não há CORS no backend, e **o renderer nunca vê access nem refresh token**. O main serializa os refresh (o backend trata dois refresh simultâneos do mesmo token como roubo). O refresh token fica salvo criptografado com `safeStorage` (keyring do sistema) em `userData`. A URL do servidor é configurável na tela de login.
- **Token LiveKit:** o renderer pede `join-token` via IPC e conecta direto no LiveKit pelo WebSocket.
- **Captura de tela:** `getDisplayMedia` no renderer; no main, `session.setDisplayMediaRequestHandler`. No Linux/Wayland, o Chromium usa o portal (PipeWire) e o próprio sistema mostra o seletor. No Windows, o app mostra um seletor próprio (fontes de `desktopCapturer.getSources` com miniaturas).
- **Áudio do sistema:**
  - Linux: `@vencord/venmic` (MPL-2.0, o mesmo do Vesktop) cria um microfone virtual no PipeWire com o áudio de todos os apps **exceto o nosso** (sem eco de outras salas). O renderer captura esse dispositivo com `getUserMedia` (AEC/NS/AGC desligados) e publica como `ScreenShareAudio`.
  - Windows: `audio: 'loopback'` no handler de display media. A verificar: excluir o áudio do próprio app.
- **Assistir (estilo Discord):** o vídeo fica na janela principal: grade com as telas ao vivo da sala, clique para focar, tela cheia. Usar `adaptiveStream`/`dynacast` do `livekit-client` para que miniaturas peçam camadas baixas e só a tela em foco venha em alta.
- **Publicação de tela:** `setScreenShareEnabled` com `contentHint: 'detail'`, 1080p30 e camadas de simulcast `h360fps3` e `h720fps15`. O áudio do sistema no Linux é publicado à parte (`publishTrack`, `ScreenShareAudio`, estéreo, `musicHighQualityStereo`, sem DTX/RED). Quando a transmissão para (inclusive pelo sistema), o áudio é derrubado junto (`LocalTrackUnpublished`).

### Estrutura (`desktop/`)
```
src/shared/api.ts          # tipos compartilhados + interface DesktopApi (window.api)
src/main/index.ts          # janela, IPC, permissões, perfis de dev
src/main/backend.ts        # cliente do backend (tokens, refresh serializado)
src/main/settings.ts       # servidor + refresh token (safeStorage) em userData
src/main/screen.ts         # display media handler, seletor (Windows), venmic (Linux)
src/preload/index.ts       # contextBridge → window.api
src/renderer/src/          # React: App, pages/ (Login, Shell, RoomPage, AdminPage),
                           # components/ (Stage, MembersPanel, Dialogs, SourcePicker), lib/api.ts
e2e/two-users.mjs          # E2E com duas instâncias (Playwright + Electron)
```

### Comandos e armadilhas
```bash
cd desktop && npm install
npm run dev                                   # app com hot reload (backend + LiveKit rodando)
npm run typecheck && npm run build
SHARESCREEN_PROFILE=b npm run dev             # segunda instância/usuário (userData separado)
SHARESCREEN_SERVER=https://... npm run dev    # servidor padrão da tela de login
E2E_ADMIN=admin:senha E2E_VIEWER=viewer:senha E2E_OUT=/tmp/shots node e2e/two-users.mjs
```
- **O terminal do VS Code exporta `ELECTRON_RUN_AS_NODE=1`**, que faz o Electron rodar como Node puro (sem janela; `electron --version` mostra a versão do Node). Rode com `env -u ELECTRON_RUN_AS_NODE npm run dev`. O script E2E já remove a variável.
- O `@vencord/venmic` é dependência opcional e nativa: precisa ficar em `external` no `electron.vite.config.ts`. Empacotado, ele não acha o binário. Exporta via CommonJS, então o `PatchBay` pode vir em `default` no `import()`.
- No E2E com duas instâncias na mesma máquina, a B fica muda: senão a A captura o áudio que a B toca (são processos diferentes, o venmic só exclui o da própria instância).
- **Verificado (Linux/Wayland, COSMIC), via E2E:** login, criar sala, adicionar membro, compartilhar (seletor do portal), assistir na outra instância (vídeo 1280x720 pela camada adaptativa) e o áudio do sistema pelo venmic (com o tom de 440 Hz tocando, o pico recebido foi para 439 Hz).
- **Pendente:** testar no Windows (seletor próprio, `loopback` e se o áudio do próprio app entra na captura), empacotamento (`electron-builder`: deb, AppImage, NSIS, ícones) e ajustes de codec/qualidade.

### Histórico do spike (Tauri, removido; ver commits até `833d4e9`)
- O WebKitGTK 2.52 do Ubuntu 24.04 vem **sem backend WebRTC** (`RTCPeerConnection` indefinido), então o `livekit-client` não roda no WebView do Tauri no Linux.
- A captura nativa com o `DesktopCapturer` do libwebrtc (portal/PipeWire) e o áudio pelo monitor do PulseAudio funcionaram. Uma recepção nativa servindo I420 por protocolo customizado e desenhando com WebGL chegou a 1080p e 30 fps. Mas manter mídia nativa em Rust mais a ponte com JS custaria bem mais que o Electron.
- O SDK Rust do LiveKit exigia clang ≥ 21 no build. Com o Electron isso não se aplica.

## Ordem de implementação

1. ✅ Backend: config, SQLite + migrations, usuários, login/refresh, subcomando de admin, testes.
2. ✅ Salas, membros, código de convite, transferência de posse, limpeza de salas temporárias, testes.
3. ✅ Integração LiveKit: join-token, webhook, `live` na listagem, derrubar conexões, limpeza verificada no LiveKit, docker-compose de dev.
   - Pendente (quando o domínio estiver configurado): compose de produção na VPS (backend + LiveKit com TURN/TLS + proxy reverso com HTTPS, ex.: Caddy).
4. ✅ Spike de captura (Tauri): concluído. Levou à troca para Electron.
5. 🔶 App desktop (Electron): ✅ esqueleto, auth via main, salas, membros, sala com compartilhar/assistir (estilo Discord), áudio do sistema no Linux, admin de usuários; pendentes: Windows, empacotamento, polimento.

## Decisões de produto

- **Áudio:** o áudio do sistema é compartilhado junto com a tela.
- **Código da sala `private`:** não expira; só muda quando o dono regenera.
- **Convites em sala `restricted`:** só o dono adiciona e remove membros.
- **Controle remoto / anotação:** fora do escopo.
- **Deploy:** VPS própria com IP público. O LiveKit precisa de portas UDP abertas (RTC 50000–60000, TURN/UDP 3478) e de TLS (TURN/TLS 5349 ou 443). O usuário tem um domínio e vai configurá-lo depois; até lá, deixar host/URLs sempre configuráveis por env, nunca fixos no código.
