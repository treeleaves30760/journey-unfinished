export default defineNuxtRouteMiddleware(async () => {
  const { user, isAdmin, refresh } = useAuth()
  await refresh()
  if (!user.value) return navigateTo('/login?redirect=/admin')
  if (!isAdmin.value) return navigateTo('/')
})
