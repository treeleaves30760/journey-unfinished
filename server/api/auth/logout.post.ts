import { clearAuthSession } from '../../utils/auth'
import { enforceSameOrigin } from '../../utils/request-security'

export default defineEventHandler((event) => {
  enforceSameOrigin(event)
  clearAuthSession(event)
  return { loggedOut: true }
})
