import { getDatabase } from '../utils/database'

export default defineEventHandler(() => {
  getDatabase().prepare('SELECT 1').get()
  return { status: 'ok', service: '未完旅箋' }
})
