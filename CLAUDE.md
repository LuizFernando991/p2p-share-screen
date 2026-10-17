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
    rooms/          # salas, membros, códigos de convite, TODAS as regras de acesso a sala
    livekit/        # implementa rooms.Media: token LiveKit, webhook, RoomService API
    httpapi/        # roteamento, handlers, erros, JSON
    store/          # acesso ao SQLite: todo SQL do projeto fica aqui
    config/         # config via variáveis de ambiente
    apperr/         # erros de domínio com código estável → status HTTP
    id/             # geração de UUIDv7
    testutil/       # helpers de teste (banco temporário)
  migrations/       # migrations SQL (goose), embutidas no binário
desktop/            # Tauri v2 + React + TS (vem depois do backend)
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

## Desktop e riscos conhecidos

- Tauri v2 + React + TS. A UI (login, salas, membros, admin) é React; **a captura e a publicação da tela são nativas em Rust**.
- **Captura de tela (decidido): nativa no lado Rust do Tauri, não por `getDisplayMedia` do WebView.** O objetivo é capturar o monitor inteiro ou qualquer janela do SO de forma confiável nos dois sistemas. No Linux, o WebView do Tauri (WebKitGTK) não suporta isso bem.
  - **Capturador (decidido pelo spike):** o `DesktopCapturer` do próprio libwebrtc do LiveKit (`livekit::webrtc::desktop_capturer`), o mesmo do Chromium. Uma API para os dois sistemas: no Linux, `DesktopCaptureSourceType::Generic` abre o seletor do xdg-desktop-portal (PipeWire) no Wayland; no Windows, `Screen`/`Window` com `get_source_list()`. Sem crates extras de captura.
  - Os frames (BGRA, que a libyuv chama de "ARGB") viram I420 com `yuv_helper::argb_to_i420` e entram num `NativeVideoSource(is_screencast=true)`, publicado com `TrackSource::Screenshare`, VP8 e simulcast.
  - **Áudio do sistema:** o capturador do Chromium só cuida de vídeo. No Linux (feito no spike): gravar de `@DEFAULT_MONITOR@` pela API simples do PulseAudio (`libpulse-simple-binding`; o pipewire-pulse atende), 48 kHz estéreo, em frames de 10 ms, num `NativeAudioSource` com AEC/NS/AGC **desligados**, publicado como `TrackSource::ScreenshareAudio` com `dtx: false`. No Windows: WASAPI loopback (ainda não escrito).
  - Cuidado: o monitor captura **tudo** o que toca no computador, inclusive o áudio de outra sala que a pessoa esteja assistindo no próprio app (vira eco para quem assiste). Resolver no app: não tocar o áudio recebido enquanto a pessoa transmite, ou excluir o stream do próprio app da captura.
  - A UI controla a captura por comandos Tauri (`list_sources`, `start_share`, `stop_share`) e recebe o estado por eventos.
- **Assistir: `livekit-client` no WebView NÃO funciona no Linux.** O WebKitGTK do Ubuntu 24.04 (2.52) é compilado sem o backend GStreamer WebRTC: o `RTCPeerConnection` fica `undefined` mesmo com `enable-webrtc` ligado. No Windows, o WebView2 (Chromium) tem WebRTC. A forma de assistir no Linux está em decisão (ver o fim do spike).

### Spike (fase 4): `desktop/spike/`
Subcomandos:
- `share`: captura tela e áudio e publica;
- `watch`: assina, salva um frame em PNG e mede o áudio;
- `view`: o mesmo que `watch`, mas dentro de um WebView `wry` com `livekit-client` 2.22.3;
- `tone`: gera um WAV de 440 Hz.

Todos fazem login no backend e pegam o token em `join-token`. Configuração por env: `SPIKE_API`, `SPIKE_USER`, `SPIKE_PASSWORD`, `SPIKE_ROOM`, `SPIKE_OUT`, `SPIKE_SOURCE`, `SPIKE_AUDIO`.
- ✅ Vídeo no Linux/Wayland (Pop!_OS 24.04, COSMIC): o seletor do portal abriu, a captura saiu em 1920x1080 a 30 fps, e o `watch` recebeu o frame pelo LiveKit com a tela correta. A listagem mostrou `live {participants: 2, publishers: 1}`.
- ✅ Áudio no Linux: com um tom de 440 Hz tocando, 82% da potência recebida estava em 440 Hz (Goertzel); sem o tom, 0%.
- ❌ Assistir no WebKitGTK: sem WebRTC (ver acima).
- ⏳ Windows (captura, áudio WASAPI, WebView2): não testado, precisa de uma máquina Windows. ⏳ Linux/X11: não testado.

### Requisitos de build (só para quem compila: dev e CI; o usuário final não precisa de nada disso)
- **clang ≥ 21**: o libwebrtc do `webrtc-sys` vem compilado com a libc++ do Chromium e o build recusa um clang mais antigo. No Ubuntu 24.04, instalar pelo apt.llvm.org (`sudo ./llvm.sh 21`). `desktop/spike/.cargo/config.toml` aponta `CC`/`CXX` para o `clang-21`.
- No Ubuntu 24.04, o clang escolhe o GCC 14 para os headers do libstdc++, mas eles só existem para o 13; o config passa `--gcc-install-dir=.../13`. Não é preciso se `libstdc++-14-dev` estiver instalado.
- O webrtc-sys só usa os **headers** do GLib/GIO; o app precisa ligar `gio-2.0`, `gobject-2.0` e `glib-2.0` (no spike, via `build.rs`; no Tauri, o GTK já liga).
- A captura no Wayland usa D-Bus assíncrono do GLib: sem um main loop do GLib rodando, o seletor nunca abre. No spike, usar a feature `glib-main-loop` do `livekit`. No Tauri, o loop do GTK já roda; verificar se a feature fica desnecessária ou atrapalha.
- Pacotes Debian/Ubuntu: `build-essential pkg-config clang libclang-dev libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libpipewire-0.3-dev libspa-0.2-dev libpulse-dev libx11-dev libxext-dev libxfixes-dev libxrandr-dev libxcomposite-dev libxdamage-dev libgl1-mesa-dev libgbm-dev libdrm-dev libva-dev`.
- Para o usuário final, o libwebrtc vai **estático** dentro do binário. Em runtime: no Linux, WebKitGTK, GLib, PipeWire e xdg-desktop-portal (presentes em qualquer desktop moderno; o `.deb` declara as dependências, o AppImage embute); no Windows, o WebView2 (já vem no Windows 10/11).

## Ordem de implementação

1. ✅ Backend: config, SQLite + migrations, usuários, login/refresh, subcomando de admin, testes.
2. ✅ Salas, membros, código de convite, transferência de posse, limpeza de salas temporárias, testes.
3. ✅ Integração LiveKit: join-token, webhook, `live` na listagem, derrubar conexões, limpeza verificada no LiveKit, docker-compose de dev.
   - Pendente (quando o domínio estiver configurado): compose de produção na VPS (backend + LiveKit com TURN/TLS + proxy reverso com HTTPS, ex.: Caddy).
4. 🔶 Spike de captura: ✅ vídeo e áudio no Linux/Wayland; ❌ assistir no WebKitGTK; pendentes: decidir como assistir no Linux, Windows e X11.
5. App desktop.

## Decisões de produto

- **Áudio:** o áudio do sistema é compartilhado junto com a tela.
- **Código da sala `private`:** não expira; só muda quando o dono regenera.
- **Convites em sala `restricted`:** só o dono adiciona e remove membros.
- **Controle remoto / anotação:** fora do escopo.
- **Deploy:** VPS própria com IP público. O LiveKit precisa de portas UDP abertas (RTC 50000–60000, TURN/UDP 3478) e de TLS (TURN/TLS 5349 ou 443). O usuário tem um domínio e vai configurá-lo depois; até lá, deixar host/URLs sempre configuráveis por env, nunca fixos no código.
