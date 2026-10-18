// Three instances on one machine: A and C share (dev test pattern + a tone
// each: 440 / 660 Hz), B watches. Checks that only the watched screen's audio
// plays and is subscribed, that it comes on the high layer, and the layout at
// narrow widths. Needs `npm run dev` (uses its renderer and the dev-only
// window.__share hook), the backend and LiveKit.
//
//   E2E_A=admin:pass E2E_B=viewer:pass E2E_C=carla:pass E2E_OUT=/tmp/shots node e2e/watch.mjs

import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
const out = process.env.E2E_OUT ?? process.argv[2] ?? 'e2e-out'
const creds = (key) => (process.env[key] ?? '').split(':')
const room = `Assistir ${new Date().toISOString().slice(11, 19)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function launch(profile, user, pass) {
  rmSync(join(homedir(), '.config', `ShareScreen-${profile}`), { recursive: true, force: true })
  const env = { ...process.env, SHARESCREEN_PROFILE: profile, ELECTRON_RENDERER_URL: 'http://localhost:5173' }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.getByLabel('Usuário').fill(user)
  await page.getByLabel('Senha').fill(pass)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.getByText('Salas', { exact: true }).waitFor()
  return { app, page }
}
const fmtIn = (s) => s ? `${s.width}x${s.height}@${Math.round(s.fps)}fps ${Math.round(s.kbps)}kbps drop=${s.framesDropped} freeze=${s.freezes}` : '-'
// Peak frequency of the audio element(s) actually playing in the page.
const playing = (page) => page.evaluate(async () => {
  const els = [...document.querySelectorAll('audio')].filter((e) => e.srcObject)
  if (els.length === 0) return { elements: 0 }
  const ctx = new AudioContext(); await ctx.resume()
  const an = ctx.createAnalyser(); an.fftSize = 16384
  for (const e of els) ctx.createMediaStreamSource(e.srcObject).connect(an)
  await new Promise((r) => setTimeout(r, 2000))
  const bins = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(bins)
  let peak = 1; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i
  await ctx.close()
  return { elements: els.length, peakHz: Math.round((peak * 48000) / 16384) }
})
const watchStats = async (page, name, n = 4) => {
  await page.evaluate(() => window.__share.stats())
  for (let i = 0; i < n; i++) { await sleep(1500); console.log(`    ${name}: ${fmtIn((await page.evaluate(() => window.__share.stats()))[name])}`) }
}

const [aUser, aPass] = creds('E2E_A')
const [bUser, bPass] = creds('E2E_B')
const [cUser, cPass] = creds('E2E_C')
const a = await launch('w-a', aUser, aPass)
const c = await launch('w-c', cUser, cPass)
const b = await launch('w-b', bUser, bPass)
// Screens are labelled with display names.
const displayName = (x) => x.page.locator('.user-names strong').textContent()
const aName = await displayName(a)
const cName = await displayName(c)
// Same machine: B must not play audio out loud (avoids loopback); analysis reads the streams.
await b.page.evaluate(() => new MutationObserver(() => document.querySelectorAll('audio').forEach((e) => (e.volume = 0.0001))).observe(document.body, { childList: true, subtree: true }))
try {
  await a.page.getByTitle('Criar sala').click()
  await a.page.getByLabel('Nome').fill(room)
  await a.page.getByRole('button', { name: 'Criar', exact: true }).click()
  for (const who of [bUser, cUser]) {
    await a.page.getByPlaceholder('Buscar pessoa…').fill(who)
    await a.page.locator('.candidate').first().click()
    await sleep(400)
  }
  for (const [x, motion, hz] of [[a, true, 440], [c, false, 660]]) {
    await x.page.locator('.room-item', { hasText: room }).click()
    await x.page.getByRole('button', { name: 'Entrar na sala' }).click()
    await x.page.getByTitle('Desconectar da sala').waitFor()
    await x.page.evaluate(([m, h]) => window.__share.testPattern(m, h), [motion, hz])
  }
  await b.page.locator('.room-item', { hasText: room }).click()
  await b.page.getByRole('button', { name: 'Entrar na sala' }).click()
  await b.page.locator('.tile.grid').nth(1).waitFor()
  await sleep(2500)
  console.log('[grade]', 'telas:', await b.page.locator('.tile.grid').count(), '| áudio tocando:', JSON.stringify(await playing(b.page)), '| inscrições:', JSON.stringify(await b.page.evaluate(() => window.__share.audioSubscriptions())))
  await b.page.screenshot({ path: join(out, '1-grade.png') })

  await b.page.locator('.tile.grid', { hasText: aName }).click()
  await sleep(3000)
  console.log('[assistindo ' + aName + '] áudio:', JSON.stringify(await playing(b.page)), '| inscrições:', JSON.stringify(await b.page.evaluate(() => window.__share.audioSubscriptions())))
  await watchStats(b.page, aName)
  await b.page.getByTitle('Qualidade da conexão').click()
  await sleep(2500)
  await b.page.screenshot({ path: join(out, '2-assistindo-luiz.png') })
  await b.page.locator('.volume').screenshot({ path: join(out, '2b-volume.png') })
  await b.page.locator('.volume-range').fill('0.35')
  await b.page.locator('.volume').screenshot({ path: join(out, '2c-volume-35.png') })

  await b.page.locator('.tile.thumb', { hasText: cName }).click()
  await sleep(3000)
  console.log('[assistindo ' + cName + '] áudio:', JSON.stringify(await playing(b.page)), '| inscrições:', JSON.stringify(await b.page.evaluate(() => window.__share.audioSubscriptions())))
  await watchStats(b.page, cName, 3)

  await b.page.getByTitle('Ver todas as telas').click()
  await sleep(1500)
  console.log('[voltou à grade] áudio:', JSON.stringify(await playing(b.page)), '| inscrições:', JSON.stringify(await b.page.evaluate(() => window.__share.audioSubscriptions())))

  await b.page.locator('.tile.grid', { hasText: aName }).click()
  for (const [w, h] of [[1000, 680], [820, 560]]) {
    await b.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
    await sleep(800)
    await b.page.screenshot({ path: join(out, `3-responsivo-${w}.png`) })
  }
  await b.page.locator('.room-header button[title="Membros"]').click()
  await sleep(500)
  await b.page.screenshot({ path: join(out, '4-membros-820.png') })
  await a.page.screenshot({ path: join(out, '5-quem-transmite.png') })
  for (const x of [a, c]) await x.page.evaluate(() => window.__share.stopTestPattern())
  await a.page.getByTitle('Desconectar da sala').click()
  await a.page.getByLabel('Mais ações').click()
  await a.page.getByRole('menuitem', { name: 'Apagar sala' }).click()
  await a.page.locator('.modal').getByRole('button', { name: 'Apagar sala' }).click()
  await sleep(500)
} catch (e) {
  console.log('FAILED:', e.message.split('\n')[0])
  await b.page.screenshot({ path: join(out, 'fail-b.png') })
}
for (const x of [a, b, c]) await x.app.evaluate(({ app }) => app.exit(0)).catch(() => {})
