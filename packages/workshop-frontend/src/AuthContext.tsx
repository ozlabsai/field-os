import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { SESSION_EXPIRED_EVENT } from './sessionExpiryBus'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
  /** Current user info, fetched once on mount. Null while loading. */
  currentUser: AiChatAuthorInfo | null
  /** Whether the current user is a deployment admin. False while loading / for non-admins. */
  isAdmin: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

interface AuthProviderProps {
  children: ReactNode
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
}

export function AuthProvider({ children, authenticatedApi, onLogout }: AuthProviderProps) {
  const [currentUser, setCurrentUser] = useState<AiChatAuthorInfo | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      if (!cancelled) setCurrentUser(info)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.amIAdmin().then((admin) => {
      if (!cancelled) setIsAdmin(admin)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  // An expired session ends the session, here, once. Every RPC in flight fails at the same moment
  // and each caller can only log something that reads like an unrelated bug, so this listens for
  // the class rather than making twelve call sites handle it -- and it is the right place because
  // this is where `logout` lives.
  //
  // Ending it is the whole recovery: logout clears the token and nulls the stub, which makes
  // __root.tsx render the login page. `classifyRpcError` calls the 'auth' class terminal, meaning
  // never quieted and never retried -- "only a fresh login cures it" is the reason to produce one,
  // not a reason to leave the user staring at a broken-looking app.
  useEffect(() => {
    // Once. The five simultaneous failures are one event as far as the user is concerned, and
    // logout is not idempotent in effect: a second call after the tree has re-rendered would be
    // acting on state that no longer exists.
    let ended = false
    const onExpired = () => {
      if (ended) return
      ended = true
      onLogout()
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => { window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired) }
  }, [onLogout])

  return (
    <AuthContext.Provider value={{ authenticatedApi, logout: onLogout, currentUser, isAdmin }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthenticatedApi() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthenticatedApi must be used within an AuthProvider')
  }
  return context
}

/** Returns the auth context when inside an AuthProvider, or null on public pages. */
export function useOptionalAuthenticatedApi(): AuthContextType | null {
  return useContext(AuthContext)
}
