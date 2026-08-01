#!/usr/bin/env bash
# 一鍵更新 production：拉最新程式碼 → 備份 → 建映像 → 遞增 tag → 部署 → 驗收。
#
# 用法（在 NAS 上，需要互動式終端機以便輸入 sudo 密碼）：
#   cd ~/journey-unfinished
#   ./deploy/k3s/scripts/update.sh              # tag 自動遞增 patch（1.1.0 -> 1.1.1）
#   ./deploy/k3s/scripts/update.sh 1.2.0        # 指定 tag
#   ./deploy/k3s/scripts/update.sh --force      # 程式碼沒變也強制重建重部署
#
# 為什麼一定要換 tag：叢集裡沒有 registry，app.yaml 用 imagePullPolicy: IfNotPresent，
# 同名 tag 不會重新載入 —— 沿用舊 tag 會「部署成功但跑的還是舊映像」。
#
# 為什麼要備份才動：strategy 是 Recreate，更新會先砍掉唯一那顆 pod。SQLite 開了 WAL，
# 大部分新資料其實在 -wal 檔裡，直接複製 .sqlite 會拿到不一致的快照，所以走 VACUUM INTO。
set -euo pipefail

# ---------------------------------------------------------------------------
# git pull 會覆寫這個檔案本身，而 bash 是「執行到哪讀到哪」的 —— 執行中被改寫會讀到
# 錯位的內容。先把自己複製到暫存檔再 exec 過去，之後的 git pull 就動不到正在跑的副本。
# REPO_ROOT 必須在複製前算好並傳下去：exec 之後 BASH_SOURCE 會指向暫存檔。
# ---------------------------------------------------------------------------
if [[ -z "${JOURNEY_UPDATE_ROOT:-}" ]]; then
  JOURNEY_UPDATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  export JOURNEY_UPDATE_ROOT
  self_copy="$(mktemp "${TMPDIR:-/tmp}/journey-update.XXXXXX")"
  cat "${BASH_SOURCE[0]}" > "$self_copy"
  exec bash "$self_copy" "$@"
fi
if [[ "$0" == "${TMPDIR:-/tmp}"/journey-update.* ]]; then
  trap 'rm -f "$0"' EXIT
fi

REPO_ROOT="$JOURNEY_UPDATE_ROOT"
HERE="$REPO_ROOT/deploy/k3s"
DEPLOY_ENV="$HERE/deploy.env"
NS=journey-unfinished
BACKUP_DIR="$HOME/journey-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { red "錯誤：$*"; exit 1; }

# 讀 deploy.env 裡的一個鍵。刻意不用 grep：grep 找不到會回傳 1，配上 set -e + pipefail
# 會讓整支腳本「印不出任何訊息就結束」—— 而「這個鍵不存在」對 DEPLOYED_COMMIT 這種
# 選擇性設定是正常狀況，不是錯誤。sed -n s///p 沒中就是輸出空字串、退出碼 0。
read_key() { sed -n "s/^$1=//p" "$DEPLOY_ENV" | tail -1 | tr -d '[:space:]'; }

FORCE=""
NEW_TAG=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) NEW_TAG="$arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# 0. 前置檢查（全部先做完再開始動，免得做到一半才發現缺東西）
# ---------------------------------------------------------------------------
step "前置檢查"
[[ -t 0 ]] || die "需要互動式終端機（build-image.sh 匯入映像要 sudo 密碼）。請用 ssh -t 連線。"
[[ -d "$REPO_ROOT/.git" ]] || die "$REPO_ROOT 不是 git repo"
[[ -f "$DEPLOY_ENV" ]] || die "缺少 ${DEPLOY_ENV}（可從 deploy.env.example 複製）"
[[ -f "$REPO_ROOT/.env" ]] || die "缺少 $REPO_ROOT/.env（Discord 機密來源）"
for c in git docker kubectl curl envsubst; do
  command -v "$c" >/dev/null || die "缺少指令：$c"
done
kubectl -n "$NS" get deploy journey-unfinished >/dev/null 2>&1 \
  || die "讀不到 deployment（KUBECONFIG=${KUBECONFIG}）"

cd "$REPO_ROOT"
[[ -z "$(git status --porcelain)" ]] \
  || die "工作目錄有未提交的變更，先處理掉再更新：$(git status --short | head -3 | tr '\n' ' ')"

CURRENT_TAG="$(read_key IMAGE_TAG)"
[[ -n "$CURRENT_TAG" ]] || die "deploy.env 讀不到 IMAGE_TAG"
# 上次成功部署的 commit，由本腳本在部署成功後寫回 deploy.env。第一次跑時不存在，屬正常。
DEPLOYED_COMMIT="$(read_key DEPLOYED_COMMIT)"
RUNNING_IMAGE="$(kubectl -n "$NS" get deploy journey-unfinished \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
echo "  目前 deploy.env  IMAGE_TAG=$CURRENT_TAG"
echo "  目前線上映像     $RUNNING_IMAGE"

# ---------------------------------------------------------------------------
# 1. 拉最新程式碼
# ---------------------------------------------------------------------------
step "拉取最新程式碼"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only
AFTER="$(git rev-parse HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "  這次沒有拉到新的 commit（HEAD 仍是 ${AFTER:0:7}）"
else
  echo "  ${BEFORE:0:7} -> ${AFTER:0:7}"
fi

# 「有沒有東西要部署」不能看這次 pull 有沒有拉到 commit —— 很多人（含 README 的第一次
# 使用說明）會先自己 git pull 再跑這支，那樣新 commit 早就進來了，這次 pull 必然是
# "Already up to date"，據此跳過會漏掉真正該部署的版本。
# 正確的判準是「線上跑的映像是不是用現在這個 HEAD 建的」，記在 deploy.env 的 DEPLOYED_COMMIT。
if [[ -n "$DEPLOYED_COMMIT" ]] && git cat-file -e "${DEPLOYED_COMMIT}^{commit}" 2>/dev/null; then
  echo "  上次部署的 commit ${DEPLOYED_COMMIT:0:7}"
  if [[ "$AFTER" == "$DEPLOYED_COMMIT" && "$RUNNING_IMAGE" == "journey-unfinished:$CURRENT_TAG" && -z "$FORCE" ]]; then
    bold $'\n線上映像就是用目前 HEAD 建的，沒有需要部署的東西。要強制重建請加 --force。'
    exit 0
  fi
  echo "  尚未上線的 commit："
  git --no-pager log --oneline "${DEPLOYED_COMMIT}..${AFTER}" | sed 's/^/    /' || true
else
  echo "  deploy.env 沒有可用的 DEPLOYED_COMMIT 記錄，一律視為需要部署"
fi

# 決定新 tag：沒指定就把最後一段 +1
if [[ -z "$NEW_TAG" ]]; then
  [[ "$CURRENT_TAG" =~ ^([0-9]+\.[0-9]+)\.([0-9]+)$ ]] \
    || die "IMAGE_TAG=$CURRENT_TAG 不是 x.y.z 格式，無法自動遞增。請手動指定：$0 <tag>"
  NEW_TAG="${BASH_REMATCH[1]}.$(( BASH_REMATCH[2] + 1 ))"
fi
[[ "$NEW_TAG" != "$CURRENT_TAG" ]] \
  || die "新 tag 與現行 tag 相同（${NEW_TAG}）。同名 tag 不會被 k3s 重新載入，請換一個。"

bold $'\n即將部署'
echo "  commit    ${AFTER:0:7}  $(git log -1 --format=%s)"
echo "  映像 tag  $CURRENT_TAG -> $NEW_TAG"
echo "  更新期間 pod 會被重建（strategy: Recreate），預期有數秒中斷。"
read -r -p $'\n按 Enter 繼續，Ctrl-C 取消... '

# sudo 密碼提早問，不要等建置十分鐘後才卡在匯入那一步
step "取得 sudo（匯入映像到 k3s containerd 需要）"
sudo -v

# ---------------------------------------------------------------------------
# 2. 備份（DB 與 uploads 必須同時，分開還原會出現有紀錄沒圖片的孤兒列）
# ---------------------------------------------------------------------------
step "備份資料庫與上傳圖片"
mkdir -p "$BACKUP_DIR"
# 沒有 pod 時 jsonpath 會報錯，set -e 會讓下一行友善的 die 永遠印不出來
POD="$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=journey-unfinished \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[[ -n "$POD" ]] || die "找不到執行中的 pod"
echo "  來源 pod: $POD"

DB_BACKUP="$BACKUP_DIR/db-$STAMP.sqlite"
UP_BACKUP="$BACKUP_DIR/uploads-$STAMP.tgz"

# better-sqlite3 不在 /app/node_modules —— Dockerfile 只複製 .output，相依套件被 nitro
# 收在 .output/server/node_modules 底下，所以裸寫 require('better-sqlite3') 會 MODULE_NOT_FOUND。
# 先問容器實際位置（找不到再 find），用絕對路徑 require，日後 nitro 換版面也不會默默壞掉。
DB_MODULE="$(kubectl -n "$NS" exec "$POD" -- sh -c \
  'ls -d /app/.output/server/node_modules/better-sqlite3 2>/dev/null \
   || find /app -maxdepth 6 -type d -name better-sqlite3 2>/dev/null | head -1' || true)"
[[ -n "$DB_MODULE" ]] || die "容器裡找不到 better-sqlite3，無法做一致性備份"

# VACUUM INTO 是 SQLite 自己的線上備份：會把 WAL 裡尚未 checkpoint 的內容一起寫進去，
# 拿到的是一致的快照。目標檔已存在時它會直接失敗，所以先清掉可能的殘留。
kubectl -n "$NS" exec "$POD" -- rm -f /tmp/backup.sqlite
kubectl -n "$NS" exec "$POD" -- node -e "
  const D = require('${DB_MODULE}');
  const db = new D('/app/data/journey-unfinished.sqlite', { readonly: true });
  db.exec(\"VACUUM INTO '/tmp/backup.sqlite'\");
  db.close();
"
kubectl -n "$NS" cp "$POD:/tmp/backup.sqlite" "$DB_BACKUP"
kubectl -n "$NS" exec "$POD" -- rm -f /tmp/backup.sqlite
kubectl -n "$NS" exec "$POD" -- tar czf - -C /app/data uploads > "$UP_BACKUP"

# 備份沒成功就不要繼續 —— 這是更新出事時唯一的退路
[[ -s "$DB_BACKUP" ]] || die "資料庫備份是空的：$DB_BACKUP"
head -c 15 "$DB_BACKUP" | grep -q "SQLite format 3" || die "備份檔頭不像 SQLite：$DB_BACKUP"
[[ -s "$UP_BACKUP" ]] || die "圖片備份是空的：$UP_BACKUP"
echo "  $DB_BACKUP  ($(du -h "$DB_BACKUP" | cut -f1))"
echo "  $UP_BACKUP  ($(du -h "$UP_BACKUP" | cut -f1))"

# ---------------------------------------------------------------------------
# 3. 建映像並匯入 containerd
# ---------------------------------------------------------------------------
step "建置映像 journey-unfinished:$NEW_TAG"
"$HERE/scripts/build-image.sh" "$NEW_TAG"

# ---------------------------------------------------------------------------
# 4. 換 tag 並部署。到這裡之後才改 deploy.env —— 建置失敗的話不該留下指向不存在映像的設定。
# ---------------------------------------------------------------------------
rollback_hint() {
  red $'\n部署失敗。回滾（舊映像還在 k3s 映像庫裡）：'
  cat <<EOF
  cd $REPO_ROOT
  sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=$CURRENT_TAG/' $DEPLOY_ENV
  ./deploy/k3s/scripts/deploy.sh

  資料若需還原（先停掉 deployment 再覆蓋 PVC 內容）：
  $DB_BACKUP
  $UP_BACKUP
EOF
}
trap rollback_hint ERR

step "更新 deploy.env 並部署"
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$NEW_TAG/" "$DEPLOY_ENV"
echo "  IMAGE_TAG=$(read_key IMAGE_TAG)"
"$HERE/scripts/deploy.sh"

# ---------------------------------------------------------------------------
# 5. 驗收
# ---------------------------------------------------------------------------
step "驗收"
APP_HOST="$(read_key APP_HOST)"
APP_NODEPORT="$(read_key APP_NODEPORT)"
APP_NODEPORT="${APP_NODEPORT:-30300}"

DEPLOYED="$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=journey-unfinished \
  -o jsonpath='{.items[0].spec.containers[0].image}' 2>/dev/null || true)"
[[ "$DEPLOYED" == "journey-unfinished:$NEW_TAG" ]] \
  || die "pod 跑的是 ${DEPLOYED}，不是預期的 journey-unfinished:$NEW_TAG"
echo "  pod 映像         $DEPLOYED"

NODEPORT_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "http://127.0.0.1:${APP_NODEPORT}/api/health" || echo 000)"
PUBLIC_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  "https://${APP_HOST}/api/health" || echo 000)"
echo "  NodePort $APP_NODEPORT   $NODEPORT_CODE"
echo "  https://$APP_HOST  $PUBLIC_CODE"
[[ "$NODEPORT_CODE" == "200" ]] || die "NodePort 健康檢查沒回 200"
[[ "$PUBLIC_CODE" == "200" ]] || die "對外健康檢查沒回 200（檢查 nginx / Cloudflare）"

# 既有三個站台不該被影響（共用同一台 host nginx）
for h in maygong.nthudsa.com maygong-cms.nthudsa.com nas.xn--essy41b.com; do
  printf '  鄰居站台 %-28s %s\n' "$h" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $h" http://127.0.0.1/ || echo 000)"
done

trap - ERR

# 記下這個映像是用哪個 commit 建的 —— 下次執行才判斷得出「線上是不是已經是 HEAD」。
if grep -qE '^DEPLOYED_COMMIT=' "$DEPLOY_ENV"; then
  sed -i "s/^DEPLOYED_COMMIT=.*/DEPLOYED_COMMIT=${AFTER}/" "$DEPLOY_ENV"
else
  printf '\n# 最後一次成功部署的 commit（由 update.sh 自動維護，不要手改）\nDEPLOYED_COMMIT=%s\n' \
    "$AFTER" >> "$DEPLOY_ENV"
fi

bold $'\n更新完成。'
cat <<EOF
  版本      $CURRENT_TAG -> ${NEW_TAG}（commit ${AFTER:0:7}）
  網址      https://${APP_HOST}
  備份      $DB_BACKUP
            $UP_BACKUP

  回滾指令（舊映像仍在 k3s 映像庫裡）：
    sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=$CURRENT_TAG/' $DEPLOY_ENV && ./deploy/k3s/scripts/deploy.sh
EOF
