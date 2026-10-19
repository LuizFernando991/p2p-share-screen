import { Check, Copy, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import type { Room } from '../../../shared/api'
import { api, errorMessage } from '../lib/api'
import { Modal } from './Dialogs'
import { useToast } from './ui'

/** Invite code of a room: copy it, or replace it (owner/admin). */
export function InviteDialog({ room, onChanged, onClose }: { room: Room; onChanged: () => void; onClose: () => void }) {
  const toast = useToast()
  const [code, setCode] = useState(room.join_code ?? '')
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function copy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function regenerate() {
    setBusy(true)
    setError('')
    try {
      const updated = await api.rooms.regenerateCode(room.id)
      setCode(updated.join_code ?? '')
      setConfirming(false)
      setCopied(false)
      toast('Novo código gerado. O anterior não funciona mais.')
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Convidar para a sala" onClose={onClose}>
      <div className="stack">
        <p className="muted">Envie este código. Quem tiver o código entra em “{room.name}”.</p>
        <div className="invite-code">
          <code>{code}</code>
          <button className={copied ? 'success-button' : 'primary'} onClick={copy}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>

        {room.can_manage &&
          (confirming ? (
            <div className="callout">
              <strong>Gerar um novo código?</strong>
              <p className="muted small">
                O código atual deixa de funcionar na hora. Quem já entrou continua na sala.
              </p>
              {error && <p className="error">{error}</p>}
              <div className="dialog-actions">
                <button className="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancelar
                </button>
                <button className="danger" onClick={regenerate} disabled={busy}>
                  {busy ? 'Gerando…' : 'Gerar novo código'}
                </button>
              </div>
            </div>
          ) : (
            <button className="ghost align-start" onClick={() => setConfirming(true)}>
              <RefreshCw size={14} /> Gerar novo código
            </button>
          ))}
      </div>
    </Modal>
  )
}
