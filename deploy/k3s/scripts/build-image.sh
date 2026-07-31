#!/usr/bin/env bash
# 在 NAS 上建置映像並匯入 k3s 的 containerd。
#
# 為什麼在 NAS 上建置而不是在 Mac 上：
#   Mac 是 arm64、NAS 是 amd64，better-sqlite3 是原生模組，跨架構必須走
#   buildx + QEMU 模擬，編譯要十幾分鐘。NAS 有 44 核心／94 GiB，直接建最快。
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
docker build --pull -t "$IMAGE" "$REPO_ROOT"

echo "==> 匯入 k3s containerd（需要 sudo：containerd socket 屬 root）"
docker save "$IMAGE" | sudo k3s ctr images import -

echo "==> 確認"
sudo k3s ctr images ls -q | grep -F "$IMAGE" || {
  echo "匯入後找不到 ${IMAGE}" >&2
  exit 1
}
echo "完成：${IMAGE} 已在 k3s 映像庫中"
