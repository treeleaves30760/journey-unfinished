#!/usr/bin/env bash
# 修正 NAS 上既有 nginx vhost 的 X-Forwarded-Proto，並安裝 Cloudflare real_ip 設定。
#
# 需要 sudo（會寫入 /etc/nginx）。請在 NAS 上執行：
#   sudo ./deploy/k3s/scripts/fix-existing-nginx.sh
#
# 修兩件事：
#
# 1) `proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;`
#    這是把「用戶端送進來的同名 header」原封轉發。正常請求下它是空值，而且完全
#    由用戶端控制 —— 後端若拿它判斷是否為 HTTPS，任何人都能謊報。應該是 $scheme，
#    也就是這一跳真實的協定。
#
# 2) 安裝 conf.d/cloudflare-realip.conf。
#    站台走 Cloudflare 代理，沒有它的話 nginx 的 $remote_addr 是 CF 邊緣節點，
#    limit_req 與傳給後端的 X-Forwarded-For 都會失準，access log 也記不到真實訪客。
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "請用 sudo 執行" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/etc/nginx/backup-${STAMP}"

echo "==> 備份到 ${BACKUP}"
mkdir -p "$BACKUP"
cp -a /etc/nginx/conf.d "$BACKUP/"
cp -a /etc/nginx/sites-enabled "$BACKUP/" 2>/dev/null || true

echo "==> 修正 X-Forwarded-Proto"
# 不要用 find 的 -o 串條件：`-type f -name '*.conf' -o -type f -path ... -print0`
# 會被解析成 (A and B) or (C and D and print0)，-print0 只綁在第二個分支上，
# conf.d/*.conf 會整批靜默消失。單純的 glob 迴圈沒有這種優先序陷阱。
changed=0
scanned=0
for conf in /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
  [ -e "$conf" ] || continue
  # sites-enabled 慣例上是指向 sites-available 的符號連結；直接 sed -i 會把連結
  # 換成實體檔案，讓兩邊從此各走各的。先解析成真實路徑再改。
  target="$(readlink -f "$conf")"
  [ -f "$target" ] || continue
  scanned=$((scanned + 1))
  if grep -q 'X-Forwarded-Proto[[:space:]]*\$http_x_forwarded_proto' "$target"; then
    sed -i 's/X-Forwarded-Proto\([[:space:]]*\)\$http_x_forwarded_proto/X-Forwarded-Proto\1$scheme/g' "$target"
    echo "    修正 $conf${target:+ -> $target}"
    changed=$((changed + 1))
  fi
done
echo "    掃描 ${scanned} 個檔案，修正 ${changed} 個"

echo "==> 安裝 Cloudflare real_ip 設定"
install -m 0644 "$HERE/nginx-cloudflare-realip.conf.example" /etc/nginx/conf.d/cloudflare-realip.conf
echo "    /etc/nginx/conf.d/cloudflare-realip.conf"

echo "==> 語法檢查"
nginx -t

echo "==> reload"
systemctl reload nginx

echo "==> 驗證：載入中的設定不應再有 \$http_x_forwarded_proto"
remaining=$(grep -rl 'X-Forwarded-Proto[[:space:]]*\$http_x_forwarded_proto' \
  /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | grep -v '/journey.conf$' || true)
if [ -n "$remaining" ]; then
  echo "    仍有殘留（請人工確認）：" >&2
  echo "$remaining" | sed 's/^/      /' >&2
else
  echo "    乾淨"
fi

echo
echo "完成。回滾方式："
echo "  sudo cp -a ${BACKUP}/conf.d/. /etc/nginx/conf.d/"
echo "  sudo rm -f /etc/nginx/conf.d/cloudflare-realip.conf"
echo "  sudo nginx -t && sudo systemctl reload nginx"
