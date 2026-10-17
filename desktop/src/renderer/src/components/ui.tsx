import { Check } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'

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

/** A "⋯"-style dropdown anchored to its trigger. Closes on outside click or Escape. */
export function Menu({ trigger, label, items }: { trigger: ReactNode; label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button className="icon" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <div className="menu-list" role="menu">
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
        </div>
      )}
    </div>
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
