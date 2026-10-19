// End-to-end run with two app instances on one machine: A (admin) creates a
// room, adds B and shares the screen; B joins and watches. Screenshots go to
// E2E_OUT. Needs the backend and LiveKit running (see CLAUDE.md) and the app
// built (npm run build). On Wayland, pick a screen in the system dialog when
// A starts sharing.
//
//   E2E_SERVER=http://localhost:8080 E2E_ADMIN=admin:pass E2E_VIEWER=viewer:pass \
//   E2E_OUT=/tmp/shots node e2e/two-users.mjs

import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron } from 'playwright-core'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = process.env.E2E_SERVER ?? 'http://localhost:8080'
const out = process.env.E2E_OUT ?? join(appDir, 'e2e-out')
const [adminUser, adminPass] = (process.env.E2E_ADMIN ?? '').split(':')
const [viewerUser, viewerPass] = (process.env.E2E_VIEWER ?? '').split(':')
const roomName = `E2E ${new Date().toISOString().slice(11, 19)}`
mkdirSync(out, { recursive: true })

const step = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)

async function launch(profile) {
  rmSync(join(homedir(), '.config', `ShareScreen-${profile}`), { recursive: true, force: true })
  const env = { ...process.env, SHARESCREEN_PROFILE: profile, SHARESCREEN_SERVER: server }
  // Set by VS Code's terminal; it would make Electron behave as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.'], cwd: appDir, env })
  const page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && console.log(`  [${profile} console] ${m.text()}`))
  return { app, page }
}

async function login(page, username, password) {
  await page.getByLabel('Usuário').fill(username)
  await page.getByLabel('Senha').fill(password)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.getByText('Salas', { exact: true }).waitFor()
}

const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) })

const a = await launch('e2e-a')
const b = await launch('e2e-b')
try {
  step('A: login as admin')
  await login(a.page, adminUser, adminPass)
  await shot(a.page, '01-a-home')

  step(`A: create fixed room "${roomName}" and add ${viewerUser}`)
  await a.page.getByTitle('Criar sala').click()
  await a.page.getByLabel('Nome').fill(roomName)
  await a.page.getByRole('button', { name: 'Criar', exact: true }).click()
  await a.page.getByLabel('Username da pessoa').fill(viewerUser)
  await a.page.getByLabel('Username da pessoa').press('Enter')
  await a.page.locator('.member-list li', { hasText: 'Pode compartilhar' }).waitFor()
  await shot(a.page, '02-a-room-members')

  step('B: login as viewer and open the room')
  await login(b.page, viewerUser, viewerPass)
  await b.page.locator('.room-item', { hasText: roomName }).click()
  await shot(b.page, '03-b-lobby')

  step('A: join and share the screen (pick a screen in the system dialog)')
  await a.page.getByRole('button', { name: 'Entrar na sala' }).click()
  await a.page.getByRole('button', { name: 'Compartilhar tela' }).click()
  await a.page.locator('.tile', { hasText: '(você)' }).waitFor({ timeout: 180_000 })
  step('A: sharing')

  step('B: join and watch')
  // Same machine: mute B's playback so A's system audio does not loop it back.
  await b.page.evaluate(() => {
    new MutationObserver(() => document.querySelectorAll('audio').forEach((el) => (el.muted = true))).observe(
      document.body,
      { childList: true, subtree: true }
    )
  })
  await b.page.getByRole('button', { name: 'Entrar na sala' }).click()
  await b.page.locator('.tile video').waitFor({ timeout: 30_000 })
  await b.page.waitForTimeout(4000)
  const video = await b.page.evaluate(() => {
    const el = document.querySelector('.tile video')
    return { width: el.videoWidth, height: el.videoHeight, frames: el.getVideoPlaybackQuality().totalVideoFrames }
  })
  step(`B: video ${video.width}x${video.height}, ${video.frames} frames decoded`)
  await shot(b.page, '04-b-watching')
  await shot(a.page, '05-a-sharing')

  // Level at 440 Hz vs the loudest bin, without and then with a test tone
  // playing (the operator plays it when "with tone" is logged).
  const measure = () =>
    b.page.evaluate(async () => {
      const el = [...document.querySelectorAll('audio')].find((e) => e.srcObject)
      if (!el) return { found: false }
      const ctx = new AudioContext()
      await ctx.resume()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 16384
      ctx.createMediaStreamSource(el.srcObject).connect(analyser)
      await new Promise((r) => setTimeout(r, 3000))
      const bins = new Float32Array(analyser.frequencyBinCount)
      analyser.getFloatFrequencyData(bins)
      const binHz = ctx.sampleRate / analyser.fftSize
      const at = (hz) => Math.max(...bins.slice(Math.round(hz / binHz) - 2, Math.round(hz / binHz) + 3))
      let peak = 1
      for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i
      await ctx.close()
      return { found: true, db440: Math.round(at(440)), peakHz: Math.round(peak * binHz), peakDb: Math.round(bins[peak]) }
    })
  step(`B: system audio without tone: ${JSON.stringify(await measure())}`)
  step('B: measuring with tone')
  await b.page.waitForTimeout(1500)
  step(`B: system audio with tone: ${JSON.stringify(await measure())}`)
} finally {
  await a.app.close()
  await b.app.close()
}
