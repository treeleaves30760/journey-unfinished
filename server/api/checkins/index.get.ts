import { listCheckins } from '../../utils/database'

export default defineEventHandler(() => ({ checkins: listCheckins() }))
