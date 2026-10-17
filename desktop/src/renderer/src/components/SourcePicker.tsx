import { useEffect, useState } from 'react'

import type { ScreenSource } from '../../../shared/api'
import { Modal } from './Dialogs'

/** Screen/window picker for platforms without a system picker (Windows). */
export function SourcePicker({ onPick, onClose }: { onPick: (sourceId: string) => void; onClose: () => void }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null)

  useEffect(() => {
    void window.api.screen.listSources().then(setSources)
  }, [])

  return (
    <Modal title="O que você quer compartilhar?" onClose={onClose}>
      {!sources ? (
        <p className="muted">Carregando…</p>
      ) : (
        <div className="sources">
          {sources.map((s) => (
            <button key={s.id} className="source" onClick={() => onPick(s.id)}>
              <img src={s.thumbnail} alt="" />
              <span>{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
