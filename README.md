# ShareScreen

Compartilhamento de tela em salas, para Windows e Linux, com acesso controlado: só entra quem o administrador cadastrou.

- **Salas fixas**: permanentes; o dono escolhe quem são os membros.
- **Salas temporárias**: entra quem tiver o código de convite; somem quando ficam vazias.
- Várias pessoas transmitindo ao mesmo tempo, em grade (estilo Discord), com tela cheia.
- **Áudio do sistema** junto com a tela (no Linux sem eco do próprio app).
- Fica na **bandeja do sistema**: o ícone mostra quando você está transmitindo e o menu permite parar.

```
App desktop (Electron) ──HTTPS──► Backend (Go + SQLite): login, salas, permissões
        │                                │ token
        └──────── WebRTC ──────────► LiveKit (SFU): distribui o vídeo para 5–50 pessoas
```

## Instalar o app

Baixe na página da [release mais recente](../../releases/latest):

| Sistema | Arquivo | Como instalar |
|---|---|---|
| Ubuntu / Debian / Pop!_OS | `sharescreen_<versão>_amd64.deb` | `sudo apt install ./sharescreen_<versão>_amd64.deb` |
| Outras distribuições Linux | `ShareScreen-<versão>-x86_64.AppImage` | `chmod +x ShareScreen-*.AppImage` e execute |
| Windows 10/11 | `ShareScreen-Setup-<versão>.exe` | Execute o instalador |

> O instalador do Windows ainda não é assinado: o SmartScreen pode avisar ("Mais informações" → "Executar assim mesmo").

**Primeiro uso:** na tela de login, clique na engrenagem ⚙ e informe o endereço do servidor (ex.: `https://share.suaempresa.com`). Depois entre com o usuário e a senha que o administrador criou.

No Linux, o áudio do sistema precisa do PipeWire (padrão nas distribuições atuais). Em Wayland, o próprio sistema mostra o seletor de tela/janela.

## Subir o servidor (VPS)

Requisitos: uma VPS Linux com IP público, Docker com Compose, e **dois domínios** (registros DNS do tipo A) apontando para ela, por exemplo `share.suaempresa.com` (API) e `livekit.suaempresa.com` (mídia).

Portas que precisam estar abertas no firewall:

| Porta | Protocolo | Uso |
|---|---|---|
| 80, 443 | TCP | HTTPS (Caddy, certificados automáticos) |
| 7881 | TCP | WebRTC por TCP (quando UDP está bloqueado) |
| 3478 | UDP | TURN |
| 50000–60000 | UDP | WebRTC (mídia) |
| 30000–40000 | UDP | TURN relay |

Passos (use o pacote `sharescreen-server-<versão>-deploy.tar.gz` da release ou um clone deste repositório):

```bash
tar xzf sharescreen-server-0.0.1-deploy.tar.gz && cd sharescreen-server-0.0.1/deploy/production
cp .env.example .env
nano .env    # domínios + segredos (openssl rand -base64 48)
docker compose up -d --build
docker compose run --rm backend admin create --username admin   # pede a senha
```

Pronto: no app, use `https://<API_DOMAIN>` como servidor e entre com o admin. Pelo app, o admin cadastra os usuários (ícone de escudo no canto inferior esquerdo).

Atualizar: baixe a nova versão, mantenha o seu `.env` e rode `docker compose up -d --build`. Os dados (SQLite) ficam no volume `backend_data`.

> O kit de produção foi validado localmente (imagem do backend, configuração do LiveKit e do Compose), mas ainda não rodou numa VPS com domínio real.

### Sem Docker

A release também traz o binário do servidor (`sharescreen-server_<versão>_linux_amd64`, `_linux_arm64`, `_windows_amd64.exe`). Ele lê a configuração de variáveis de ambiente (veja [`backend/.env.example`](backend/.env.example)) e precisa de um LiveKit e de um proxy HTTPS na frente:

```bash
./sharescreen-server admin create --username admin
APP_JWT_SECRET=... LIVEKIT_URL=wss://livekit.suaempresa.com LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... ./sharescreen-server
```

## Desenvolvimento

Requisitos: Go 1.26+, Node 25+ com npm, Docker.

```bash
# LiveKit local
docker compose -f deploy/docker-compose.yml up -d

# Backend (em outro terminal)
cd backend
APP_JWT_SECRET=$(openssl rand -base64 48) LIVEKIT_URL=ws://localhost:7880 \
  LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=dev-secret-change-me-dev-secret-change-me \
  go run ./cmd/server
go run ./cmd/server admin create --username admin
go test -race ./...

# App desktop
cd desktop
npm install
npm run dev                                   # no terminal do VS Code: env -u ELECTRON_RUN_AS_NODE npm run dev
SHARESCREEN_PROFILE=b npm run dev             # segunda instância (outro usuário)
npm run typecheck
```

Empacotar (pare o `npm run dev` antes, porque o build apaga `out/`):

```bash
cd desktop
npm run dist:linux    # release/: .deb e .AppImage
npm run dist:win      # release/: instalador .exe (no Linux precisa do wine)
```

Detalhes de arquitetura, decisões e armadilhas conhecidas estão no [`CLAUDE.md`](CLAUDE.md).
