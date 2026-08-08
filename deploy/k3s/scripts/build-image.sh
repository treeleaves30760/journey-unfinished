#!/usr/bin/env bash
# 在部署主機上建置映像並匯入 k3s 的 containerd。
#
# 為什麼要在部署主機上建，而不是在開發機上建好再傳過去：
#   開發機常是 arm64（Apple Silicon），部署主機常是 amd64，而 better-sqlite3 與
#   sharp 都是原生模組 —— 跨架構必須走 buildx + QEMU 模擬，編譯要十幾分鐘。
#   直接在目標架構上建最快也最可靠。
#
# 為什麼要 ctr import：
#   叢集裡沒有 registry。docker build 出來的映像在 dockerd，k3s 用的是自己的
#   containerd，兩者不共用映像庫，必須明確匯入。
#
# 用法（在 NAS 上、專案根目錄）：
#   ./deploy/k3s/scripts/build-image.sh 1.0.0
set -euo pipefail

IMAGE_TAG="${1:-}"
if [[ -z "$IMAGE_TAG" ]]; then
  echo "用法: $0 <image-tag>   例如: $0 1.0.0" >&2
  exit 1
fi

IMAGE="journey-unfinished:${IMAGE_TAG}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

echo "==> 建置 ${IMAGE}（${REPO_ROOT}）"
# --provenance/--sbom=false：buildx 預設會附加 attestation manifest，讓 docker save
#   產出 manifest list。k3s 的 containerd 匯入那種格式會多出 unknown/unknown 平台
#   條目，kubelet 有機會挑錯而拉不到映像。這個叢集只需要單一平台，關掉最單純。
# --platform linux/amd64：明確釘住部署主機的架構。若有人在 arm64 機器上跑，
#   寧可讓它明確地慢，也不要產出在目標主機跑不起來的映像。
docker build --pull \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -t "$IMAGE" "$REPO_ROOT"

echo "==> 匯入 k3s containerd"
# containerd 的 socket 屬 root，這一步一定要 sudo。非互動 shell（例如
# `ssh host '...'`）沒有 tty，sudo 讀不到密碼會直接失敗 —— 先講清楚怎麼做，
# 而不是讓人對著 "a terminal is required" 猜。
if ! sudo -n true 2>/dev/null && [ ! -t 0 ]; then
  cat >&2 <<EOF

映像已建好，但匯入需要 sudo 密碼，而目前這個 shell 沒有 tty。
請改用互動式連線再跑一次（映像已快取，會很快）：

  ssh -t <部署主機> 'cd <專案目錄> && ./deploy/k3s/scripts/build-image.sh ${IMAGE_TAG}'

EOF
  exit 1
fi
docker save "$IMAGE" | sudo k3s ctr images import -

echo "==> 確認"
sudo k3s ctr images ls -q | grep -F "$IMAGE" || {
  echo "匯入後找不到 ${IMAGE}" >&2
  exit 1
}
echo "完成：${IMAGE} 已在 k3s 映像庫中"
