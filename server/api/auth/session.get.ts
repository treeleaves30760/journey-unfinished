import { getCurrentUser } from '../../utils/auth'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  return {
    user: getCurrentUser(event),
    discordConfigured: Boolean(config.discordClientId && config.discordClientSecret && config.public.appUrl)
  }
})
