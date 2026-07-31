import { createError } from 'h3'
import { createComment, findCheckin } from '../../../../utils/database'
import { clientAddress, enforceRateLimit, enforceSameOrigin, readLimitedJson } from '../../../../utils/request-security'
import { assertUniqueComment, parseId, validateComment } from '../../../../utils/validation'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  // 爆量閘擺在時量閘前面：enforceRateLimit 連被擋下的那次也會計數，
  // 先過短窗才代表連按或腳本的洪峰不會順帶把整個小時的額度燒掉。
  // 5 則／分鐘 —— 認真寫一則留言至少要十幾秒，正常訪客碰不到這條線，
  // 腳本卻被壓到平均 12 秒才過一則，留下足夠時間讓後面兩層察覺。
  enforceRateLimit(event, 'create-comment-burst', 5, 60 * 1000)
  // 每小時 30 則是整體上限，擋的是刻意壓在爆量閘之下、慢慢洗一整天的節奏。
  // 沿用原本的數值：留言比發旅箋輕量，一小時 30 則對真人已經是極端上緣。
  enforceRateLimit(event, 'create-comment', 30, 60 * 60 * 1000)

  const id = parseId(getRouterParam(event, 'id'))
  if (!findCheckin(id)) throw createError({ statusCode: 404, message: '找不到這則旅箋' })
  // 單篇另計，否則一個來源可以把整份時量額度全倒在同一則旅箋上，把原作者的留言洗到看不見。
  // 10 則／小時：同一人在同一篇下面的往返對話，超過十則已經不是留言而是洗版。
  // 刻意放在 404 判斷之後 —— key 含 id，若讓不存在的編號也建桶，隨機 id 就能灌爆有上限的計數表。
  enforceRateLimit(event, `create-comment-checkin:${id}`, 10, 60 * 60 * 1000)

  const body = await readLimitedJson(event, 8 * 1024)
  const input = validateComment(body)
  // 指紋算的是正規化、去空白後的內容，所以必須排在 validateComment 之後；
  // 也不能在驗證失敗時就先記錄，否則使用者改好格式重送會被自己上一次的失敗紀錄擋住。
  assertUniqueComment(clientAddress(event), input.nickname, input.message)
  const comment = createComment(id, input.nickname, input.message)
  setResponseStatus(event, 201)
  return { comment }
})
