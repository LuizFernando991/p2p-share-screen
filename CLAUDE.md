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
deploy/             # docker-compose.yml + livekit.dev.yaml (LiveKit local de dev); production/ = kit da VPS
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

Nos dois tipos, entra quem tiver o **código de convite** da sala, ou quem o dono adicionar digitando o **username exato** (não existe busca nem lista de usuários).

| Tipo | Duração | Dono pode sair? |
|---|---|---|
| `restricted` (**fixa**) | Permanente | Sim, depois de **transferir a posse** para outro membro (`POST /api/rooms/{id}/owner`) |
| `private` (**temporária**) | Apagada depois de ficar **vazia** (ninguém conectado no LiveKit) por `APP_TEMP_ROOM_GRACE` (padrão 5 min) | Não: ele apaga a sala, ou ela acaba sozinha ao esvaziar |

- Toda regra de permissão fica em `internal/rooms` (`authorize`, `CanManage`, `CanPublish`).
- Membros (`room_members`): `role` = `owner` | `member`, mais a flag `can_publish` (se pode transmitir; padrão `true`). O dono também é uma linha em `room_members` e sempre pode transmitir.
- Numa sala fixa, os membros entram e transmitem a qualquer hora, mesmo com o dono offline.
- Só o dono (ou o admin) adiciona/remove membros, muda `can_publish`, renomeia, apaga e regenera o código. Um membro pode sair por conta própria (`DELETE /members/{seu id}`).
- Entrar com código válido adiciona o usuário como membro (ele volta sem o código). Regenerar o código não remove quem já entrou. O código só aparece na resposta para o dono e o admin.
- Sala temporária: a coluna `rooms.empty_since` marca desde quando ela está vazia (começa preenchida na criação). Os webhooks do LiveKit limpam essa coluna quando alguém entra e a preenchem quando a sala fecha (ver "Fluxo para entrar e transmitir"). A rotina `cleanupLoop` (a cada 1 min) apaga as que passaram do prazo.
- Apagar um usuário apaga as salas de que ele é dono (cascade).
- O admin enxerga e gerencia qualquer sala.
- Código de convite: 8 caracteres de um alfabeto de 32 símbolos sem `0/1/I/O`, exibido como `K7QF-2MXP`, gerado com `crypto/rand`. A entrada aceita minúsculas, com ou sem hífen. Tentativas têm rate limit por usuário.
- Adicionar membro (`POST /members {username}`) exige o username exato (sem diferenciar maiúsculas). Conta desativada responde como inexistente (`user_not_found`), e não há endpoint de busca: ninguém consegue listar quem tem conta.
- A migration `00003_room_codes` deu código às salas fixas que já existiam (reconstrói `rooms`; os membros são preservados).
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

# salas
GET    /api/rooms                      salas em que sou membro/dono (admin: todas)
POST   /api/rooms                      {name, type: restricted|private}
GET    /api/rooms/{id}
PATCH  /api/rooms/{id}                 dono/admin: {name}
DELETE /api/rooms/{id}                 dono/admin
POST   /api/rooms/{id}/code/regenerate dono/admin
POST   /api/rooms/{id}/owner           dono/admin: {user_id} (só restricted; alvo precisa ser membro)
POST   /api/rooms/join-by-code         {code}
GET    /api/rooms/{id}/members
POST   /api/rooms/{id}/members         dono/admin: {username, can_publish?} (username exato)
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
cd backend && go build -ldflags "-X main.version=0.0.1" ./cmd/server   # versão no binário (`server version`)

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
- **Bandeja (Windows e Linux):** `Tray` do Electron, menu enxuto. Durante a transmissão: "Parar de compartilhar", "Mostrar/Ocultar janela" e "Sair"; fora dela, só "Mostrar/Ocultar" e "Sair". Quem indica a transmissão é o próprio ícone: glifo monocromático (claro em painel escuro, escuro em painel claro, pelo `nativeTheme`) com um ponto vermelho ao transmitir. Bandejas do Linux (StatusNotifier) não entregam clique no ícone; no Windows o clique alterna a janela.
  - O renderer manda `{ room, sharing }` (`window.api.tray.setState`) e o main pede para parar via IPC `tray:stop-share` (`window.api.tray.onStopShare`). O `stop()` sempre reenvia o estado no fim, para a bandeja nunca ficar dessincronizada.
  - Fechar a janela esconde o app na bandeja (avisa uma vez, por notificação). Uma instância por perfil: abrir de novo traz a janela de volta (`requestSingleInstanceLock`).
  - Testável sem mexer na tela: o menu é exportado via dbusmenu; dá para ler (`GetLayout`) e clicar (`Event ... clicked`) com `busctl --user` no item `org.freedesktop.StatusNotifierItem-<pid>-1`.
- **Assistir (estilo Discord):** quem assiste **escolhe uma tela**. Ela fica em destaque, recebe a camada **alta** (`setVideoQuality(HIGH)`) e é a **única com áudio**: o `Stage` toca só o `ScreenShareAudio` dela (`<AudioTrack>`) e **dessinscreve** (`setSubscribed(false)`) o áudio das outras. As demais viram miniaturas na camada baixa. Com uma tela só na sala, ela entra em destaque sozinha; o botão de grade volta para todas (sem áudio). A escolha é por participante (identity), então sobrevive a recompartilhar.
  - `adaptiveStream` fica **desligado**: com ele, a camada era escolhida pelo tamanho do elemento, e uma tela em destaque numa janela comum caía na camada do meio. `dynacast` continua ligado (camadas sem ninguém assistindo pausam no transmissor).
  - **Responsividade:** os controles ficam numa linha e se ajustam **por medição** (`useFitLevels` no `Stage`): a cada render e resize, o app verifica se os grupos cabem (comparando larguras, porque `scrollWidth` ignora o transbordo em caixas `overflow: visible`) e aplica níveis cumulativos até caber: `data-c1` (some contagem, % do volume e o texto de limitação), `data-c2` (botões e chip de áudio só com ícone, fps do selo some, slider e seletor encolhem), `data-c3` (permite segunda linha). Grupos e itens têm `flex-shrink: 0`, então o que não cabe transborda e é detectado em vez de se sobrepor. Larguras fixas (media/container queries) falharam com a fonte e a tela do usuário. Verificado de 1280 a 800 px, a cada 20 px, com zoom de 100% e 115%, parado e transmitindo (com o seletor de qualidade na opção mais larga): nenhuma sobreposição, e o centro de cada controle é clicável (`elementFromPoint`). A tela assistida é dimensionada em 16:9 com `cqw`/`cqh` (`.watch-main` é container de tamanho), para nome, ações e estatísticas ficarem sobre o vídeo. A grade usa `auto-fit` com mínimo de 300 px por coluna. Abaixo de 1180 px de janela, o painel de membros flutua sobre o palco; a barra de controles fica acima dele (`z-index`), senão o painel cobria Compartilhar e Desconectar.
  - Painel "Qualidade da conexão" (ícone de atividade na tela assistida): resolução, fps, bitrate, perda, jitter, congelamentos. Quem transmite vê nos controles a camada alta saindo e se há limitação por CPU/banda (`lib/stats.ts`, a partir de `getRTCStatsReport`).
- **Publicação de tela (`lib/share.ts`):** quem transmite escolhe, antes de começar, a **qualidade** (720p, 1080p ou 1440p/2K, a 30 ou 60 fps; padrão 1080p30) e o **modo**. Os dois ficam salvos no `localStorage` (`shareQuality`, `shareMode`). A tela nunca é ampliada: um monitor 1080p em "1440p" sai em 1080p. Camadas de simulcast: **360p15** sempre e **720p30** quando a camada alta passa de 720p (todas com fps assistível).
  - **Fluidez** (padrão): `contentHint: 'motion'` (sem banda, baixa a resolução e mantém o fps). Tetos (Mbps): 720p 4/7, 1080p 8/15, 1440p 14/25 (30/60 fps);
  - **Nitidez**: `contentHint: 'detail'` (mantém a resolução e baixa o fps). Tetos: 720p 2,5/4, 1080p 5/8, 1440p 8/12.
  - O VP8 **descarta quadros** para caber no teto, então teto baixo aparece como fps perdido, não como borrão. Medido com o padrão em movimento (pior caso, transmissor e espectador na mesma máquina, Ryzen 7 5700X): 1440p60 a 18 Mbps chegava a ~43 fps; a 25 Mbps, 46–52 fps (envio a 55); 1080p60 a 15 Mbps, 54–59 fps; 1440p30 a 14 Mbps, 30 fps. Codificação da 1440p ~12 ms por quadro. H.264 (OpenH264) foi pior (~25 ms por quadro, ~34 fps), e o VP9 caiu para uma camada só de 360p. Tirar a camada 720p não mudou o fps.
  - Custo: o SFU repassa a camada alta para cada espectador que assiste aquela tela. 1440p60 a 25 Mbps com 20 espectadores são até ~500 Mbps de saída da VPS.
  - Medido (Ryzen 7 5700X, local): antes, quem assistia recebia **720p a 15 fps** (camada `h720fps15` + adaptiveStream); com 5 Mbps, movimento intenso em 1080p caía para 22 fps (teto de bitrate). Agora: 1080p a 30 fps (~8 Mbps em movimento intenso), sem quadros perdidos. Codificação de 4 a 6 ms por quadro: a CPU não era o gargalo. O áudio do sistema no Linux é publicado à parte (`publishTrack`, `ScreenShareAudio`, estéreo, `musicHighQualityStereo`, sem DTX/RED). Quando a transmissão para (inclusive pelo sistema), o áudio é derrubado junto (`LocalTrackUnpublished`).

### Estrutura (`desktop/`)
```
src/shared/api.ts          # tipos compartilhados + interface DesktopApi (window.api)
src/main/index.ts          # janela, IPC, permissões, perfis de dev
src/main/backend.ts        # cliente do backend (tokens, refresh serializado)
src/main/settings.ts       # servidor + refresh token (safeStorage) em userData
src/main/screen.ts         # display media handler, seletor (Windows), venmic (Linux)
src/main/tray.ts           # ícone e menu da bandeja (estado da chamada, ações)
resources/                 # ícones em runtime (janela, bandeja normal/ao vivo); fonte em build/icon.svg
src/preload/index.ts       # contextBridge → window.api
src/renderer/src/          # React: App, pages/ (Login, Shell, RoomPage, AdminPage),
                           # components/ (Stage, MembersPanel, Dialogs, SourcePicker), lib/api.ts
e2e/two-users.mjs          # E2E com duas instâncias (Playwright + Electron)
e2e/watch.mjs              # E2E com três instâncias: escolher tela, áudio isolado, camada alta, layout estreito
src/renderer/src/lib/share.ts  # opções de captura/publicação (modos) + padrão de teste (dev)
src/renderer/src/lib/stats.ts  # resumo das estatísticas WebRTC (envio/recebimento)
```

### Comandos e armadilhas
```bash
cd desktop && npm install
npm run dist:linux                            # release/: sharescreen_<v>_amd64.deb e ShareScreen-<v>-x86_64.AppImage
npm run dist:win                              # instalador NSIS (gerar no Windows ou com wine)
npm run dev                                   # hot reload da UI; main/preload reiniciam o app (--watch)
npm run typecheck && npm run build
SHARESCREEN_PROFILE=b npm run dev             # segunda instância/usuário (userData separado)
SHARESCREEN_SERVER=https://... npm run dev    # servidor padrão da tela de login
E2E_ADMIN=admin:senha E2E_VIEWER=viewer:senha E2E_OUT=/tmp/shots node e2e/two-users.mjs
E2E_A=admin:senha E2E_B=viewer:senha E2E_C=terceiro:senha E2E_OUT=/tmp/shots node e2e/watch.mjs   # precisa do npm run dev
```
- **Gancho de diagnóstico (só em dev):** `window.__share` no `Stage`: `testPattern(motion, toneHz?)` publica um padrão animado na qualidade escolhida no seletor (e um tom como áudio da tela) com as mesmas opções da tela real, sem o seletor; `stats()` e `audioSubscriptions()` leem o estado. Instâncias de teste usam `ELECTRON_RENDERER_URL=http://localhost:5173` para pegar o renderer de dev.
- **Recusar `getDisplayMedia` no Electron 43:** não há API de recusa. `callback({})` faz a página rejeitar na hora com `AbortError` ("Invalid capture constraints"), mas o callback também lança no main ("Video was requested..."). Por isso `deny()` envolve em `try/catch`, e a página trata `AbortError` como cancelamento (além de `NotAllowedError`).
- **O dev server do Vite pode ficar servindo CSS/módulos antigos** depois de edições que trocam o arquivo (`perl -i`, `sed -i`), mesmo com `touch`: a requisição direta (`curl localhost:5173/src/styles.css?direct`) mostra o novo, mas a página segue com o antigo. Antes de medir layout, confira na própria página (`getComputedStyle`) que a regra nova está ativa; se não estiver, reinicie o `npm run dev`. Ao conferir com `curl`, procure trechos de **código**: o Vite remove comentários.
- **`npm run build`/`dist:*` apagam `out/`, que o `npm run dev` usa:** pare o dev antes de empacotar.
- **O terminal do VS Code exporta `ELECTRON_RUN_AS_NODE=1`**, que faz o Electron rodar como Node puro (sem janela; `electron --version` mostra a versão do Node). Rode com `env -u ELECTRON_RUN_AS_NODE npm run dev`. O script E2E já remove a variável.
- O `@vencord/venmic` é dependência opcional e nativa: precisa ficar em `external` no `electron.vite.config.ts`. Empacotado, ele não acha o binário. Exporta via CommonJS, então o `PatchBay` pode vir em `default` no `import()`.
- No E2E com duas instâncias na mesma máquina, a B fica muda: senão a A captura o áudio que a B toca (são processos diferentes, o venmic só exclui o da própria instância).
- **Verificado (Linux/Wayland, COSMIC), via E2E:** login, criar sala, adicionar membro, compartilhar (seletor do portal), assistir na outra instância (vídeo 1280x720 pela camada adaptativa) e o áudio do sistema pelo venmic (com o tom de 440 Hz tocando, o pico recebido foi para 439 Hz).
- **Pendente:** testar no Windows (seletor próprio, `loopback` e se o áudio do próprio app entra na captura), empacotamento (`electron-builder`: deb, AppImage, NSIS, ícones) e ajustes de codec/qualidade.

### Ícones e empacotamento
- Fonte: `build/icon.svg` (gradiente Mauve → Blue + glifo do monitor), `build/icon-small-glyph.svg` (glifo simplificado para 16/24 px) e `build/tray-*.svg` (bandeja monocromática). O ImageMagick 6 não renderiza gradiente de SVG, então os PNGs do app são compostos em camadas (gradiente + máscara arredondada + glifo). Saídas: `build/icons/NxN.png` (16 a 1024, Linux), `build/icon.ico` (Windows), `build/icon.png` e `resources/icon.png` (janela).
- Identidade: `package.json` `desktopName: sharescreen.desktop` dá à janela o app_id `sharescreen` no Wayland. O compositor acha o ícone pelo `.desktop` de mesmo nome (o electron-builder gera `sharescreen.desktop` a partir de `linux.executableName`). No Windows, `app.setAppUserModelId('com.sharescreen.app')` (= `appId`) liga a barra de tarefas ao atalho e ao `.ico`.
- `electron-builder.yml`: deb (pacote `sharescreen`, recomenda `libpipewire-0.3-0t64 \| libpipewire-0.3-0` por causa do venmic), AppImage, NSIS por usuário. `resources/**` e o venmic ficam fora do asar (caminhos reais para ícones de bandeja/notificação e o addon nativo). **`homepage` no package.json é provisório** (`sharescreen.example.com`), trocar quando o domínio existir.
- **Atualização automática** (`src/main/updater.ts`, `electron-updater`): lê as releases públicas do GitHub (`publish: github`, `LuizFernando991/share-screen`). Só roda no app empacotado: checa ao abrir e a cada 4 h, baixa em segundo plano e instala ao **sair** (nunca reinicia no meio de uma transmissão). Quando a atualização está pronta, aparecem uma notificação e o item "Reiniciar para atualizar (versão)" na bandeja. AppImage e Windows atualizam sozinhos; o .deb instala com `pkexec` (pede a senha de administrador).
  - **Publicar uma versão:** subir `version` no `package.json`, rodar `npm run dist:linux` e `dist:win` e enviar para a release do GitHub, além dos instaladores, os arquivos **`latest-linux.yml`, `latest.yml` e o `.exe.blockmap`**. Sem eles, os apps instalados não enxergam a versão nova. A release não pode ser rascunho nem pré-lançamento. Os scripts usam `--publish never`: o envio continua manual.
  - Testar antes de publicar: `SHARESCREEN_UPDATE_URL=http://127.0.0.1:8765/` faz o app empacotado ler uma pasta HTTP comum. Verificado com AppImage (0.0.7 → 0.0.8, servindo a pasta de saída do build com `python3 -m http.server`): baixou, mostrou o item na bandeja, trocou o arquivo e reabriu na versão nova. O `http.server` não aceita requisição parcial, então o download diferencial falha e cai no completo (o GitHub aceita).
  - A primeira versão com o atualizador ainda precisa ser instalada à mão uma vez.
- Libs da UI (React, LiveKit, Lucide) ficam em `devDependencies`: o Vite as empacota no bundle, e assim o instalador não leva cópias no `node_modules`.
- Verificado: o app empacotado (`release/linux-unpacked`) abre, registra a bandeja e carrega o venmic.

### Histórico do spike (Tauri, removido; ver commits até `833d4e9`)
- O WebKitGTK 2.52 do Ubuntu 24.04 vem **sem backend WebRTC** (`RTCPeerConnection` indefinido), então o `livekit-client` não roda no WebView do Tauri no Linux.
- A captura nativa com o `DesktopCapturer` do libwebrtc (portal/PipeWire) e o áudio pelo monitor do PulseAudio funcionaram. Uma recepção nativa servindo I420 por protocolo customizado e desenhando com WebGL chegou a 1080p e 30 fps. Mas manter mídia nativa em Rust mais a ponte com JS custaria bem mais que o Electron.
- O SDK Rust do LiveKit exigia clang ≥ 21 no build. Com o Electron isso não se aplica.

## Ordem de implementação

1. ✅ Backend: config, SQLite + migrations, usuários, login/refresh, subcomando de admin, testes.
2. ✅ Salas, membros, código de convite, transferência de posse, limpeza de salas temporárias, testes.
3. ✅ Integração LiveKit: join-token, webhook, `live` na listagem, derrubar conexões, limpeza verificada no LiveKit, docker-compose de dev.
   - Kit de produção em `deploy/production/` (Caddy com HTTPS automático + backend + LiveKit em rede do host, configurado via `LIVEKIT_CONFIG`; o backend recebe os webhooks em `127.0.0.1:8080`). Validado localmente (imagem, config), ainda não numa VPS real. O TURN usa UDP 3478 e o relay UDP 30000–40000; sem TURN/TLS por enquanto.
4. ✅ Spike de captura (Tauri): concluído. Levou à troca para Electron.
5. 🔶 App desktop (Electron): ✅ esqueleto, auth via main, salas, membros, sala com compartilhar/assistir (estilo Discord), áudio do sistema no Linux, admin de usuários; pendentes: Windows, empacotamento, polimento.

## Decisões de produto

- **Áudio:** o áudio do sistema é compartilhado junto com a tela.
- **Código de convite (todas as salas):** não expira e é reutilizável; só muda quando o dono regenera. Quem entra pelo código pode transmitir.
- **Adicionar por nome:** só o dono (ou admin), digitando o username exato; não há lista de usuários.
- **Controle remoto / anotação:** fora do escopo.
- **Deploy:** VPS própria com IP público. O LiveKit precisa de portas UDP abertas (RTC 50000–60000, TURN/UDP 3478) e de TLS (TURN/TLS 5349 ou 443). O usuário tem um domínio e vai configurá-lo depois; até lá, deixar host/URLs sempre configuráveis por env, nunca fixos no código.
