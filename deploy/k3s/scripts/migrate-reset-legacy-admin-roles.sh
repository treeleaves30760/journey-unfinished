#!/usr/bin/env bash
# 一次性遷移：清掉舊登入路徑寫進 users.role 的 'admin' 殘留。
#
# ## 背景
#
# 舊版的 upsertDiscordUser 會在登入時把「由 NUXT_ADMIN_DISCORD_IDS 推導出來的
# role」寫進資料列。結果是設定管理員第一次登入就把 'admin' 固化進資料庫，
# 之後把他從環境變數移除也撤銷不掉 —— 文件寫的撤銷方式會靜默失效。
#
# 新版登入完全不碰 role，兩層因此互不汙染：
#   - 設定管理員（NUXT_ADMIN_DISCORD_IDS）每次請求計算，隨時可撤銷
#   - 授權管理員（users.role）只由管理頁的 PATCH 端點寫入
#
# 但既有資料庫裡的殘留列，與「管理頁授權的管理員」在資料上完全無法分辨。
#
# ## 什麼時候跑這個腳本是安全的
#
# 只有在「管理頁的權限切換功能從未在這個環境使用過」時才安全 —— 此時每一筆
# role='admin' 都必然是殘留。一旦你開始用管理頁授權管理員，這個腳本就會把
# 那些人一起降級，因為它分不出來。
#
# 所以它要求 --yes 明示確認，而且不該被排進任何自動化流程。
#
# ## 影響
#
# 設定管理員不受影響：他們的權限來自環境變數，每次請求重算，跟資料列無關。
# 跑完之後 users.role 全部是 'user'，管理權完全由 NUXT_ADMIN_DISCORD_IDS
# 決定，之後要加人再從管理頁授權。
#
# 用法（在 NAS 上、專案根目錄）：
#   ./deploy/k3s/scripts/migrate-reset-legacy-admin-roles.sh          # 只檢視，不修改
#   ./deploy/k3s/scripts/migrate-reset-legacy-admin-roles.sh --yes    # 實際執行
set -euo pipefail

NS=journey-unfinished
APPLY=0
[[ "${1:-}" == "--yes" ]] && APPLY=1

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
SQLITE=/app/.output/server/node_modules/better-sqlite3
DB=/app/data/journey-unfinished.sqlite

POD="$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=journey-unfinished -o name | head -1)"
[[ -n "$POD" ]] || { echo "找不到執行中的 pod" >&2; exit 1; }

echo "==> 目前狀態"
kubectl -n "$NS" exec "$POD" -- node -e "
  const db = new (require('$SQLITE'))('$DB', { readonly: true })
  const rows = db.prepare('SELECT id, discord_id AS did, username, role FROM users ORDER BY id').all()
  for (const r of rows) console.log('   id=' + r.id, r.did, r.username, 'role=' + r.role)
  console.log('   role=admin 的列數:', rows.filter(r => r.role === 'admin').length)
"

if [[ $APPLY -eq 0 ]]; then
  cat <<'EOF'

這是檢視模式，資料庫沒有被修改。

確認上面列出的 role=admin 都是舊登入路徑留下的殘留（也就是你還沒用過管理頁的
權限切換功能）之後，加上 --yes 重跑：

  ./deploy/k3s/scripts/migrate-reset-legacy-admin-roles.sh --yes
EOF
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/journey-backups"
mkdir -p "$BACKUP_DIR"

echo "==> 先備份（VACUUM INTO，不是 cp —— WAL 模式下直接複製會拿到不一致的快照）"
kubectl -n "$NS" exec "$POD" -- node -e "
  const db = new (require('$SQLITE'))('$DB', { readonly: true })
  db.exec(\"VACUUM INTO '/tmp/pre-migration.sqlite'\")
"
kubectl -n "$NS" cp "${POD#pod/}:/tmp/pre-migration.sqlite" "$BACKUP_DIR/pre-migration-${STAMP}.sqlite"
ls -l "$BACKUP_DIR/pre-migration-${STAMP}.sqlite"

echo "==> 執行遷移"
kubectl -n "$NS" exec "$POD" -- node -e "
  const db = new (require('$SQLITE'))('$DB')
  const changes = db.prepare(\"UPDATE users SET role = 'user' WHERE role = 'admin'\").run().changes
  console.log('   重設的列數:', changes)
  const rows = db.prepare('SELECT id, username, role FROM users ORDER BY id').all()
  for (const r of rows) console.log('   id=' + r.id, r.username, 'role=' + r.role)
  const left = rows.filter(r => r.role === 'admin').length
  if (left) { console.error('   仍有 role=admin 未清除:', left); process.exit(1) }
  console.log('   完整性 — users:', db.prepare('SELECT COUNT(*) c FROM users').get().c,
              'checkins:', db.prepare('SELECT COUNT(*) c FROM checkins').get().c,
              'comments:', db.prepare('SELECT COUNT(*) c FROM comments').get().c,
              'sessions:', db.prepare('SELECT COUNT(*) c FROM auth_sessions').get().c)
"

cat <<EOF

完成。管理權現在完全由 NUXT_ADMIN_DISCORD_IDS 決定，之後要加人請從管理頁授權。

回滾（若需要）：
  kubectl -n $NS cp "$BACKUP_DIR/pre-migration-${STAMP}.sqlite" "${POD#pod/}:/tmp/restore.sqlite"
  kubectl -n $NS scale deploy/journey-unfinished --replicas=0
  # 把 /tmp/restore.sqlite 覆蓋回 PVC 上的 journey-unfinished.sqlite，並刪掉 -wal/-shm
  kubectl -n $NS scale deploy/journey-unfinished --replicas=1
EOF
