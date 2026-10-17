# p2p-share-screen

App desktop (Windows e Linux) de compartilhamento de tela em salas, com acesso controlado: só entra quem o admin cadastrou.

## Arquitetura

```
┌──────────────────────┐   HTTPS (REST)    ┌──────────────────────┐
│ desktop/ (Tauri v2)  │ ────────────────► │ backend/ (Go)        │
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
    rooms/          # salas, membros, códigos de convite, regras de acesso
    livekit/        # emissão de token LiveKit, webhook, chamadas à API do LiveKit
    httpapi/        # roteamento, handlers, erros, JSON
    store/          # acesso ao SQLite: todo SQL do projeto fica aqui
    config/         # config via variáveis de ambiente
    apperr/         # erros de domínio com código estável → status HTTP
    id/             # geração de UUIDv7
    testutil/       # helpers de teste (banco temporário)
  migrations/       # migrations SQL (goose), embutidas no binário
desktop/            # Tauri v2 + React + TS (vem depois do backend)
deploy/             # docker-compose (backend + LiveKit), livekit.yaml
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

| Tipo | Como se entra | Quem gerencia |
|---|---|---|
| `restricted` | Só quem está na lista de membros, definida pelo dono | Dono adiciona/remove membros |
| `private` | Quem tiver o **código** da sala | Dono pode regenerar o código (o antigo deixa de valer) |

- Membros (`room_members`): `role` = `owner` | `member`, mais a flag `can_publish` (se pode transmitir; padrão `true`).
- Entrar com código válido numa sala `private` adiciona o usuário como membro (ele consegue voltar sem o código). Regenerar o código não remove quem já entrou.
- O admin enxerga e pode apagar qualquer sala.
- Código de convite: curto, legível, sem caracteres ambíguos (ex.: `K7QF-2MXP`), gerado com `crypto/rand`. Tentativas de código têm rate limit por usuário e por IP.
- O nome da sala no LiveKit é o `id` da sala no nosso banco.

### Fluxo para entrar e transmitir
1. Cliente: `POST /api/rooms/{id}/join-token`.
2. Backend checa: usuário ativo, é membro (ou dono, ou admin) → gera token LiveKit com `roomJoin`, `canSubscribe=true`, `canPublish=can_publish`, `canPublishSources=[screen_share, screen_share_audio]`, identity = user id, name = nome de exibição, TTL curto.
3. Cliente conecta no LiveKit e publica/assina as faixas.
4. O webhook do LiveKit (`POST /api/livekit/webhook`, com assinatura verificada) informa quem está transmitindo, para a listagem de salas mostrar "ao vivo".
5. Quando alguém é removido da sala ou desativado, o backend chama `RemoveParticipant` na API do LiveKit para derrubar a conexão.

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

# salas
GET    /api/rooms                      salas em que sou membro/dono (admin: todas)
POST   /api/rooms                      {name, type}
GET    /api/rooms/{id}
PATCH  /api/rooms/{id}                 dono/admin
DELETE /api/rooms/{id}                 dono/admin
POST   /api/rooms/{id}/code/regenerate dono (só private)
POST   /api/rooms/join-by-code         {code}
GET    /api/rooms/{id}/members
POST   /api/rooms/{id}/members         dono: {user_id, can_publish}
PATCH  /api/rooms/{id}/members/{uid}   dono: can_publish
DELETE /api/rooms/{id}/members/{uid}   dono, ou o próprio membro saindo
POST   /api/rooms/{id}/join-token      → {livekit_url, token}

POST   /api/livekit/webhook
GET    /healthz
```

Erros sempre no formato `{"error": {"code": "room_not_found", "message": "..."}}`. Para não vazar a existência de recursos, quem não tem acesso a uma sala recebe 404, não 403.

## Convenções

- Identificadores, código e mensagens de commit em inglês; documentação e conversa em português.
- IDs são UUIDv7 (ordenáveis), salvos como TEXT. Datas em UTC, RFC 3339.
- Toda checagem de permissão fica em `internal/rooms` (ou `auth`), nunca espalhada nos handlers. Handler fino: decodifica, chama o serviço, serializa.
- Config só por variáveis de ambiente (`APP_ADDR`, `APP_DB_PATH`, `APP_JWT_SECRET`, `APP_ACCESS_TTL`, `APP_REFRESH_TTL`, `APP_TRUST_PROXY`; na fase 3, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`). Segredos nunca entram no repo; `backend/.env.example` documenta as variáveis.
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

# infra local
docker compose -f deploy/docker-compose.yml up  # LiveKit (modo dev)
```

## Desktop (fase 2) e riscos conhecidos

- Tauri v2 + React + TS. A UI (login, salas, membros, admin) é React; **a captura e a publicação da tela são nativas em Rust**.
- **Captura de tela (decidido): nativa no lado Rust do Tauri, não por `getDisplayMedia` do WebView.** O objetivo é capturar o monitor inteiro ou qualquer janela do SO de forma confiável nos dois sistemas. No Linux, o WebView do Tauri (WebKitGTK) não suporta isso bem.
  - Windows: Windows Graphics Capture API.
  - Linux: Wayland via `xdg-desktop-portal` + PipeWire (o SO mostra o seletor de tela/janela); X11 via XShm/XComposite.
  - Candidatos de crate: `scap` (multiplataforma, WGC + PipeWire), `xcap`. Escolher no spike.
  - Publicação: SDK Rust do LiveKit (`livekit` crate). Os frames capturados entram num `NativeVideoSource`, e a codificação (VP8/H.264, simulcast) fica com o libwebrtc do SDK.
  - Áudio do sistema: Windows via WASAPI loopback; Linux via monitor do PipeWire/PulseAudio.
  - A UI controla a captura por comandos Tauri (`list_sources`, `start_share`, `stop_share`) e recebe o estado por eventos.
- **Assistir (a validar no spike):** a primeira opção é `livekit-client` no WebView. O suporte a WebRTC do WebKitGTK também é limitado, então, se falhar no Linux, assinar a faixa pelo SDK Rust e entregar os frames para a UI renderizar.
- **Spike antes da UI (fase 4):** capturar, publicar e assistir uma tela via LiveKit no Windows, no Linux/Wayland e no Linux/X11.

## Ordem de implementação

1. ✅ Backend: config, SQLite + migrations, usuários, login/refresh, subcomando de admin, testes.
2. Salas, membros, código de convite, regras de acesso, testes.
3. Integração LiveKit: join-token, webhook, remoção de participantes; docker-compose com LiveKit.
4. Spike de captura de tela no Tauri (Windows e Linux).
5. App desktop.

## Decisões de produto

- **Áudio:** o áudio do sistema é compartilhado junto com a tela.
- **Código da sala `private`:** não expira; só muda quando o dono regenera.
- **Convites em sala `restricted`:** só o dono adiciona e remove membros.
- **Controle remoto / anotação:** fora do escopo.
- **Deploy:** VPS própria com IP público. O LiveKit precisa de portas UDP abertas (RTC 50000–60000, TURN/UDP 3478) e de TLS (TURN/TLS 5349 ou 443). **Pendente:** definir o domínio, necessário para os certificados TLS da API e do LiveKit.
