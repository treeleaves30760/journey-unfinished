export interface SessionUser {
  id: number
  displayName: string
  username: string
  avatarUrl: string | null
  role: 'user' | 'admin'
}

interface AuthSession {
  user: SessionUser | null
  discordConfigured: boolean
}

export function useAuth() {
  const { data, refresh } = useFetch<AuthSession>('/api/auth/session', {
    key: 'auth-session',
    default: () => ({ user: null, discordConfigured: true })
  })
  const user = computed(() => data.value.user)
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function logout() {
    await $fetch('/api/auth/logout', { method: 'POST' })
    await refresh()
    await navigateTo('/')
  }

  function loginPath(returnTo = '/') {
    return `/auth/discord?returnTo=${encodeURIComponent(returnTo)}`
  }

  return { session: data, user, isAdmin, refresh, logout, loginPath }
}
