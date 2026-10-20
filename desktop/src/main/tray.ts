import { join, sep } from 'node:path'

import { BrowserWindow, Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions } from 'electron'

import type { MediaState } from '../shared/api'

// resources/ is unpacked from the asar in builds, so files get real paths
// (needed by Linux notifications and trays).
export const resource = (name: string): string =>
  join(__dirname, '../../resources', name).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)

/**
 * System tray icon (Windows notification area, Linux StatusNotifier). The
 * icon itself shows whether a share is live (red dot); the menu stays short:
 * "Stop sharing" only while sharing, plus show/hide and quit. Linux trays do
 * not deliver icon clicks, so the menu is the only control there; on Windows
 * a click also toggles the window.
 */
export class AppTray {
  private tray: Tray | null = null
  private state: MediaState = { room: null, sharing: false }
  private update: { version: string; install: () => void } | null = null

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly quit: () => void
  ) {}

  create(): void {
    this.tray = new Tray(this.icon())
    this.tray.on('click', () => this.toggleWindow())
    nativeTheme.on('updated', () => this.refresh())
    this.refresh()
  }

  setState(state: MediaState): void {
    this.state = state
    this.refresh()
  }

  /** A downloaded update: offers "restart to update" in the menu. */
  setUpdateReady(version: string, install: () => void): void {
    this.update = { version, install }
    this.refresh()
  }

  /** Rebuilds icon, tooltip and menu, e.g. after the window was shown or hidden. */
  refresh(): void {
    if (!this.tray) return
    const { room, sharing } = this.state
    const visible = this.window()?.isVisible() ?? false

    this.tray.setImage(this.icon())
    this.tray.setToolTip(sharing ? `ShareScreen · compartilhando em ${room}` : room ? `ShareScreen · em ${room}` : 'ShareScreen')

    const template: MenuItemConstructorOptions[] = [
      ...(sharing
        ? ([
            { label: 'Parar de compartilhar', click: () => this.window()?.webContents.send('tray:stop-share') },
            { type: 'separator' }
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { label: visible ? 'Ocultar janela' : 'Mostrar janela', click: () => this.toggleWindow() },
      ...(this.update
        ? ([{ label: `Reiniciar para atualizar (${this.update.version})`, click: this.update.install }] satisfies MenuItemConstructorOptions[])
        : []),
      { label: 'Sair do ShareScreen', click: this.quit }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  showWindow(): void {
    const win = this.window()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  private toggleWindow(): void {
    const win = this.window()
    if (win?.isVisible() && win.isFocused()) win.hide()
    else this.showWindow()
  }

  /** Monochrome glyph: light on dark panels, dark on light ones; red dot while sharing. */
  private icon(): Electron.NativeImage {
    const tone = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'
    return nativeImage.createFromPath(resource(`tray-${tone}${this.state.sharing ? '-live' : ''}.png`))
  }
}
