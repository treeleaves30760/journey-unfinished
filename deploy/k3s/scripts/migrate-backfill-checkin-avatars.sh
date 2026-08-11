#!/usr/bin/env bash
# 一次性遷移：把娃娃檔案的頭像補回「有連到娃娃、但自己沒有頭像」的舊旅箋。
#
# ## 背景
#
# 娃娃檔案（doll profiles）之後才有，在那之前寫下的旅箋沒有辦法從檔案帶頭像；
# 更早的版本則是讓沒有頭像的旅箋顯示一張 CSS 畫出來的預設臉。那張臉已經整組移除，
# 現在沒有頭像的旅箋會退回自己的旅途照片，再沒有才是純色圓圈。
#
# 有些旅箋其實有 doll_id，只是寫下的當時沒把頭像複製過去。這些補得回來，
# 而且補回去比退回旅途照片更貼近原意 —— 那是娃娃本人的臉。
#
# 沒有 doll_id 的舊旅箋不在這個腳本的範圍內：無從得知該用誰的頭像，
# 「名字一樣就是同一隻」會把不同人的同名娃娃綁在一起。那些旅箋交給旅途照片的退路。
#
# ## 為什麼是複製檔案而不是共用路徑
#
# 刪除旅箋會連它的圖檔一起刪（見 checkins/[id].delete.ts）。若多列共用同一個路徑，
# 刪掉其中一則就會弄壞娃娃檔案本身與其他所有引用它的旅箋 —— 而且是靜默地壞掉。
# 規則因此是「每一列各自持有一份」，與 server/utils/uploads.ts 的 copySavedImage 一致。
#
# ## 影響
#
# 只寫 checkins.avatar 這一個欄位，而且只寫目前是 NULL 的列。已經有頭像的旅箋、
# 娃娃檔案本身、以及所有既有圖檔都不會被改動。重跑是安全的（第二次會找不到待補的列）。
#
# 用法（在 NAS 上、專案根目錄）：
#   ./deploy/k3s/scripts/migrate-backfill-checkin-avatars.sh          # 只檢視，不修改
#   ./deploy/k3s/scripts/migrate-backfill-checkin-avatars.sh --yes    # 實際執行
set -euo pipefail

NS=journey-unfinished
APPLY=0
[[ "${1:-}" == "--yes" ]] && APPLY=1

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
SQLITE=/app/.output/server/node_modules/better-sqlite3
DB=/app/data/journey-unfinished.sqlite
UPLOADS=/app/data/uploads

POD="$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=journey-unfinished -o name | head -1)"
[[ -n "$POD" ]] || { echo "找不到執行中的 pod" >&2; exit 1; }

echo "==> 目前狀態"
kubectl -n "$NS" exec "$POD" -- node -e "
  const fs = require('fs'), path = require('path')
  const db = new (require('$SQLITE'))('$DB', { readonly: true })
  const total = db.prepare('SELECT COUNT(*) AS c FROM checkins').get().c
  const missing = db.prepare('SELECT COUNT(*) AS c FROM checkins WHERE avatar IS NULL').get().c
  const orphan = db.prepare('SELECT COUNT(*) AS c FROM checkins WHERE avatar IS NULL AND doll_id IS NULL').get().c
  const rows = db.prepare(
    'SELECT c.id, c.location, c.doll_name AS dollName, d.name AS profile, d.avatar AS dollAvatar' +
    ' FROM checkins c JOIN dolls d ON d.id = c.doll_id' +
    ' WHERE c.avatar IS NULL AND d.avatar IS NOT NULL ORDER BY c.id'
  ).all()
  console.log('   旅箋總數:', total, '／ 沒有頭像:', missing, '（其中沒連娃娃檔案、補不了的:', orphan + '）')
  console.log('   可以補的:', rows.length)
  for (const r of rows) {
    const src = path.join('$UPLOADS', path.basename(r.dollAvatar))
    const ok = fs.existsSync(src) ? '' : '  ← 來源檔不存在，會跳過'
    console.log('     #' + r.id, r.location, '｜' + r.dollName, '→ 娃娃檔案「' + r.profile + '」' + ok)
  }
"

if [[ $APPLY -eq 0 ]]; then
  cat <<'EOF'

這是檢視模式，資料庫沒有被修改。

上面「可以補的」那幾則，會各自複製一份娃娃檔案的頭像圖檔（不共用路徑），
然後把 checkins.avatar 指到自己那一份。確認之後加上 --yes 重跑：

  ./deploy/k3s/scripts/migrate-backfill-checkin-avatars.sh --yes

「沒連娃娃檔案、補不了的」那些不會被動到 —— 它們會顯示自己的旅途照片。
EOF
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/journey-backups"
mkdir -p "$BACKUP_DIR"

echo "==> 先備份（VACUUM INTO，不是 cp —— WAL 模式下直接複製會拿到不一致的快照）"
kubectl -n "$NS" exec "$POD" -- node -e "
  const db = new (require('$SQLITE'))('$DB', { readonly: true })
  db.exec(\"VACUUM INTO '/tmp/pre-backfill.sqlite'\")
"
kubectl -n "$NS" cp "${POD#pod/}:/tmp/pre-backfill.sqlite" "$BACKUP_DIR/pre-backfill-${STAMP}.sqlite"
ls -l "$BACKUP_DIR/pre-backfill-${STAMP}.sqlite"

echo "==> 執行回填"
kubectl -n "$NS" exec "$POD" -- node -e "
  const crypto = require('crypto'), fs = require('fs'), path = require('path')
  const db = new (require('$SQLITE'))('$DB')
  const rows = db.prepare(
    'SELECT c.id, d.avatar AS dollAvatar FROM checkins c JOIN dolls d ON d.id = c.doll_id' +
    ' WHERE c.avatar IS NULL AND d.avatar IS NOT NULL ORDER BY c.id'
  ).all()
  const update = db.prepare('UPDATE checkins SET avatar = ? WHERE id = ? AND avatar IS NULL')

  // 先把檔案複製完再一次寫資料庫：複製失敗的列直接跳過，不會留下指向不存在檔案的 avatar。
  const copied = []
  for (const r of rows) {
    const source = path.join('$UPLOADS', path.basename(r.dollAvatar))
    const extension = path.extname(source).slice(1) || 'webp'
    const filename = 'avatar-' + crypto.randomBytes(18).toString('hex') + '.' + extension
    try {
      fs.copyFileSync(source, path.join('$UPLOADS', filename), fs.constants.COPYFILE_EXCL)
      fs.chmodSync(path.join('$UPLOADS', filename), 0o600)
      copied.push({ id: r.id, url: '/uploads/' + filename })
    } catch (error) {
      console.log('   跳過 #' + r.id + '：無法複製來源圖檔（' + error.code + '）')
    }
  }

  let changed = 0
  db.transaction(() => { for (const c of copied) changed += update.run(c.url, c.id).changes })()
  console.log('   補上頭像的旅箋:', changed, '／ 複製的圖檔:', copied.length)

  // 複製了檔案卻沒寫進資料庫的話（理論上不會發生），那些檔案是孤兒，清掉。
  if (changed !== copied.length) {
    console.error('   複製數與更新數不一致，請人工檢查上傳目錄')
    process.exit(1)
  }

  const left = db.prepare('SELECT COUNT(*) AS c FROM checkins WHERE avatar IS NULL AND doll_id IS NOT NULL').get().c
  console.log('   仍然沒有頭像、但有連娃娃檔案的:', left, '（來源圖檔不存在的話會留在這裡）')
  console.log('   完整性 — checkins:', db.prepare('SELECT COUNT(*) c FROM checkins').get().c,
              'dolls:', db.prepare('SELECT COUNT(*) c FROM dolls').get().c,
              'comments:', db.prepare('SELECT COUNT(*) c FROM comments').get().c)
"

cat <<EOF

完成。沒連到娃娃檔案的舊旅箋不受影響，它們會顯示自己的旅途照片。

回滾（若需要）：
  kubectl -n $NS cp "$BACKUP_DIR/pre-backfill-${STAMP}.sqlite" "${POD#pod/}:/tmp/restore.sqlite"
  kubectl -n $NS scale deploy/journey-unfinished --replicas=0
  # 把 /tmp/restore.sqlite 覆蓋回 PVC 上的 journey-unfinished.sqlite，並刪掉 -wal/-shm
  kubectl -n $NS scale deploy/journey-unfinished --replicas=1
  # 複製出來的頭像檔會變成孤兒，可以留著（幾十 KB）或手動清掉
EOF
