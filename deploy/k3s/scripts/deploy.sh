#!/usr/bin/env bash
# 套用 k3s 資源。機密由 .env 讀出後建成 Secret，不會寫進任何 YAML。
#
# 用法（在 NAS 上、專案根目錄，且 .env 已填好 Discord 設定）：
#   cp deploy/k3s/deploy.env.example deploy/k3s/deploy.env  # 改 APP_HOST / IMAGE_TAG
#   ./deploy/k3s/scripts/deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
NS=journey-unfinished

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

command -v envsubst >/dev/null || { echo "缺少 envsubst：sudo apt install -y gettext-base" >&2; exit 1; }
[[ -f "$HERE/deploy.env" ]] || { echo "缺少 $HERE/deploy.env（可從 deploy.env.example 複製）" >&2; exit 1; }
[[ -f "$REPO_ROOT/.env" ]]  || { echo "缺少 $REPO_ROOT/.env（Discord 機密來源）" >&2; exit 1; }

set -a; source "$HERE/deploy.env"; set +a
: "${APP_HOST:?deploy.env 未設定 APP_HOST}"
: "${IMAGE_TAG:?deploy.env 未設定 IMAGE_TAG}"
# NODE_CIDR 沒有通用預設值 —— 猜錯會讓 NetworkPolicy 擋掉 NodePort 進來的流量，
# 症狀是「部署成功但 nginx 502」，很難一眼看出原因。寧可在這裡就停下來。
: "${NODE_CIDR:?deploy.env 未設定 NODE_CIDR（節點內網位址，例如 10.0.0.1/32。查法見 deploy.env.example）}"
: "${APP_NODEPORT:=30300}"; export APP_NODEPORT
: "${DATA_SIZE:=10Gi}"; export DATA_SIZE

# .env 只取需要的三個值，避免把 NUXT_PUBLIC_APP_URL 之類的本機設定帶進叢集
# （那些由 ConfigMap 依 APP_HOST 產生）。
read_env() { grep -E "^${1}=" "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- ; }
DISCORD_CLIENT_ID="$(read_env NUXT_DISCORD_CLIENT_ID)"
DISCORD_CLIENT_SECRET="$(read_env NUXT_DISCORD_CLIENT_SECRET)"
ADMIN_DISCORD_IDS="$(read_env NUXT_ADMIN_DISCORD_IDS)"
[[ -n "$DISCORD_CLIENT_ID" && -n "$DISCORD_CLIENT_SECRET" ]] \
  || { echo ".env 內的 NUXT_DISCORD_CLIENT_ID / NUXT_DISCORD_CLIENT_SECRET 是空的" >&2; exit 1; }

echo "==> namespace / 應用資源（APP_HOST=${APP_HOST}, IMAGE_TAG=${IMAGE_TAG}）"
envsubst '${APP_HOST} ${IMAGE_TAG} ${APP_NODEPORT} ${DATA_SIZE} ${NODE_CIDR}' < "$HERE/app.yaml" | kubectl apply -f -

echo "==> Secret（--dry-run | apply 讓重跑可以就地更新）"
kubectl -n "$NS" create secret generic journey-secrets \
  --from-literal=NUXT_DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" \
  --from-literal=NUXT_DISCORD_CLIENT_SECRET="$DISCORD_CLIENT_SECRET" \
  --from-literal=NUXT_ADMIN_DISCORD_IDS="$ADMIN_DISCORD_IDS" \
  --dry-run=client -o yaml | kubectl apply -f -

# Secret 換值不會自動重啟 pod，明確 restart 一次。
kubectl -n "$NS" rollout restart deploy/journey-unfinished
echo "==> 等待就緒"
kubectl -n "$NS" rollout status deploy/journey-unfinished --timeout=300s

echo
kubectl -n "$NS" get pod,svc,pvc

echo
echo "==> 自我測試（在 pod 內打自己，繞過 NetworkPolicy）"
kubectl -n "$NS" exec deploy/journey-unfinished -- node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log('health',r.status,await r.text()))"

echo
echo "==> 從 host 經 NodePort 驗證（nginx 就是打這個埠）"
curl -s -o /dev/null -w "  nodeport ${APP_NODEPORT} -> %{http_code}\n" \
  --max-time 8 "http://127.0.0.1:${APP_NODEPORT}/api/health" || echo "  NodePort 不可達，檢查 NetworkPolicy 與 Service"

echo
echo "下一步：設定 nginx vhost（deploy/k3s/nginx-journey.conf.example，proxy_pass 到 ${APP_NODEPORT}）"
