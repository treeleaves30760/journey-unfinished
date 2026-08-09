#!/usr/bin/env bash
# 部署自架的地點搜尋（Photon）。與應用程式解耦：不跑這支，應用會照舊用公用 Nominatim。
#
# 用法（在 NAS 上、專案根目錄）：
#   ./deploy/k3s/scripts/deploy-geocoder.sh            # 部署／更新
#   ./deploy/k3s/scripts/deploy-geocoder.sh --status   # 只看目前狀態與下載進度
#
# 第一次啟動會下載全球索引（約 57 GiB 壓縮 → 95 GB 解開後），依頻寬要數小時。
# 期間 pod 是 Running 但 not ready，這是正常的 —— 用 --status 看進度。
#
# 部署完成之後，還要把應用指過去才會生效：
#   deploy/k3s/deploy.env 設 GEOCODER_PROVIDER=photon
#                            GEOCODER_URL=http://photon.geocoder.svc.cluster.local:2322
#   再跑 ./deploy/k3s/scripts/deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS=geocoder

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

command -v envsubst >/dev/null || { echo "缺少 envsubst：sudo apt install -y gettext-base" >&2; exit 1; }
[[ -f "$HERE/deploy.env" ]] || { echo "缺少 $HERE/deploy.env（可從 deploy.env.example 複製）" >&2; exit 1; }

set -a; source "$HERE/deploy.env"; set +a

# 這些都有安全的通用預設值，不像 NODE_CIDR 那樣猜錯會壞掉，所以給預設而不是強制填。
: "${PHOTON_IMAGE:=rtuszik/photon-docker:latest}"; export PHOTON_IMAGE
: "${PHOTON_DATA_SIZE:=200Gi}"; export PHOTON_DATA_SIZE
: "${PHOTON_HEAP:=4g}"; export PHOTON_HEAP
: "${PHOTON_MEMORY_LIMIT:=10Gi}"; export PHOTON_MEMORY_LIMIT
: "${PHOTON_UPDATE_STRATEGY:=SEQUENTIAL}"; export PHOTON_UPDATE_STRATEGY
: "${PHOTON_UPDATE_INTERVAL:=720h}"; export PHOTON_UPDATE_INTERVAL
# 12 小時的啟動寬限（30 秒 × 1440）。第一次下載慢過頭時 kubelet 才不會把它殺掉重來。
: "${PHOTON_STARTUP_FAILURES:=1440}"; export PHOTON_STARTUP_FAILURES

status() {
  echo "==> 資源"
  kubectl -n "$NS" get pod,svc,pvc 2>/dev/null || { echo "  尚未部署"; return 0; }
  echo
  echo "==> 就緒狀態"
  local ready
  ready="$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=photon \
    -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || echo '')"
  if [[ "$ready" == "true" ]]; then
    echo "  ready — 索引已就緒，可以查詢"
    echo
    echo "==> 試查一筆"
    kubectl -n "$NS" exec deploy/photon -- \
      sh -c 'wget -qO- "http://127.0.0.1:2322/api?q=Taipei%20101&limit=1&lang=default"' 2>/dev/null \
      | head -c 400 || echo "  查詢失敗"
    echo
  else
    echo "  尚未就緒（第一次啟動要下載並解開數十 GB，這是正常的）"
  fi
  echo
  echo "==> 資料量"
  kubectl -n "$NS" exec deploy/photon -- du -sh /photon/data 2>/dev/null || echo "  （pod 還沒起來）"
  echo
  echo "==> 最近的日誌"
  kubectl -n "$NS" logs deploy/photon --tail=15 2>/dev/null || true
}

if [[ "${1:-}" == "--status" ]]; then
  status
  exit 0
fi

echo "==> 檢查節點剩餘空間（索引需要約 95 GB，更新期間 PARALLEL 策略會短暫需要兩份）"
AVAIL_GB="$(df -BG --output=avail /var/lib/rancher/k3s 2>/dev/null | tail -1 | tr -dc '0-9')"
if [[ -n "$AVAIL_GB" ]]; then
  echo "  /var/lib/rancher/k3s 可用 ${AVAIL_GB}G"
  [[ "$AVAIL_GB" -ge 150 ]] || {
    echo "  空間不足（建議至少 150G）。清出空間後再試，或把 REGION 改成單一國家。" >&2
    exit 1
  }
fi

echo "==> 套用 geocoder 資源（image=${PHOTON_IMAGE}, PVC=${PHOTON_DATA_SIZE}）"
envsubst '${PHOTON_IMAGE} ${PHOTON_DATA_SIZE} ${PHOTON_HEAP} ${PHOTON_MEMORY_LIMIT} ${PHOTON_UPDATE_STRATEGY} ${PHOTON_UPDATE_INTERVAL} ${PHOTON_STARTUP_FAILURES}' \
  < "$HERE/geocoder.yaml" | kubectl apply -f -

echo
echo "==> 等待 pod 排程（不是等索引下載完 —— 那要數小時）"
kubectl -n "$NS" rollout status deploy/photon --timeout=180s || true

echo
status

cat <<'EOF'

下一步：
  1. 索引下載完成前先不要切換。用這行看進度（可反覆執行）：
       ./deploy/k3s/scripts/deploy-geocoder.sh --status
  2. 顯示 ready 之後，在 deploy/k3s/deploy.env 設定：
       GEOCODER_PROVIDER=photon
       GEOCODER_URL=http://photon.geocoder.svc.cluster.local:2322
  3. 套用到應用：
       ./deploy/k3s/scripts/deploy.sh
EOF
