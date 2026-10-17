import { useEffect, useState } from 'react'

import type { Session } from '../../shared/api'
import { Login } from './pages/Login'
import { Shell } from './pages/Shell'

type State = { status: 'loading' } | { status: 'anonymous'; expired?: boolean } | { status: 'ready'; session: Session }

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    void window.api.auth.session().then((session) => {
      setState(session ? { status: 'ready', session } : { status: 'anonymous' })
    })
    return window.api.auth.onExpired(() => setState({ status: 'anonymous', expired: true }))
  }, [])

  if (state.status === 'loading') return <div className="splash">Carregando…</div>
  if (state.status === 'anonymous') {
    return <Login expired={state.expired} onLogin={(session) => setState({ status: 'ready', session })} />
  }
  return (
    <Shell
      session={state.session}
      onLogout={async () => {
        await window.api.auth.logout()
        setState({ status: 'anonymous' })
      }}
    />
  )
}
