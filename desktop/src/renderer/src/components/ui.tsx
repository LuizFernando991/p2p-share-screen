import { Check } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import { errorMessage } from '../lib/api'
import { Modal } from './Dialogs'

/** Asks before an action with consequences; shows its error inline. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<unknown>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <div className="confirm-message">{message}</div>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className={danger ? 'danger' : 'primary'} onClick={confirm} disabled={busy} autoFocus>
            {busy ? 'Aguarde…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  /** Shows a check mark; for toggles. */
  checked?: boolean
  onSelect: () => void
}

const MENU_GAP = 4
const VIEWPORT_MARGIN = 8

/**
 * A "⋯"-style dropdown. The list is portaled to <body> with fixed
 * positioning, so scrolling/overflow containers (like the members panel)
 * cannot clip it. It aligns to the trigger's right edge, flips above when
 * there is no room below, and closes on outside click, Escape, scroll or
 * resize.
 */
export function Menu({ trigger, label, items }: { trigger: ReactNode; label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !listRef.current) return
    const anchor = triggerRef.current.getBoundingClientRect()
    const list = listRef.current.getBoundingClientRect()
    const below = anchor.bottom + MENU_GAP
    const top =
      below + list.height > window.innerHeight - VIEWPORT_MARGIN ? anchor.top - MENU_GAP - list.height : below
    const left = Math.min(
      Math.max(anchor.right - list.width, VIEWPORT_MARGIN),
      window.innerWidth - list.width - VIEWPORT_MARGIN
    )
    setPosition({ top: Math.max(top, VIEWPORT_MARGIN), left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    // Capture: scrolling any ancestor would leave the fixed list behind.
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  function toggle() {
    setPosition(null)
    setOpen(!open)
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={`icon ${open ? 'active' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            className="menu-list"
            role="menu"
            // Measured first while hidden, then placed (no flash at 0,0).
            style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}
          >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item ${item.danger ? 'is-danger' : ''}`}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span className="menu-icon">{item.icon}</span>
              <span className="menu-label">{item.label}</span>
              {item.checked !== undefined && <span className="menu-check">{item.checked && <Check size={14} />}</span>}
            </button>
          ))}
          </div>,
          document.body
        )}
    </>
  )
}

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

const ToastContext = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined)

/** Short-lived notices at the bottom of the window. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const show = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800)
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
