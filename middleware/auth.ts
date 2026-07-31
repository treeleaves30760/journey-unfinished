export default defineNuxtRouteMiddleware(async (to) => {
  const { user, refresh } = useAuth()
  await refresh()
  if (!user.value) return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
})
