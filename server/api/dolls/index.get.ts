import { requireUser } from '../../utils/auth'
import { lastNicknameOf, listDolls } from '../../utils/database'

/**
 * 只回自己的娃娃。清單依「最近用過」排序，選擇器直接拿第一筆當預設值。
 *
 * lastNickname 一起回是因為它們是同一件事的兩半：這支端點回答的是「打開寫旅箋的表單時，
 * 該預先填什麼」。分成兩支端點會讓表單為了填預設值打兩次請求，卻沒有任何好處。
 */
export default defineEventHandler((event) => {
  const user = requireUser(event)
  return { dolls: listDolls(user.id), lastNickname: lastNicknameOf(user.id) }
})
