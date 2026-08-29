#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env"
tmp_file=""
minimax_key=""

cleanup() {
  unset minimax_key
  if [[ -n "$tmp_file" && -f "$tmp_file" ]]; then
    rm -f "$tmp_file"
  fi
}
trap cleanup EXIT INT TERM

replace_key=0
if [[ "${1:-}" == "--replace" ]]; then
  replace_key=1
elif [[ $# -gt 0 ]]; then
  echo "用法：npm run setup:minimax [-- --replace]" >&2
  exit 1
fi

if [[ "$replace_key" -eq 0 && -f "$env_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == MINIMAX_API_KEY=* ]]; then
      minimax_key="${line#MINIMAX_API_KEY=}"
      break
    fi
  done < "$env_file"
fi

if [[ -n "$minimax_key" ]]; then
  echo "偵測到現有 MINIMAX_API_KEY，將直接接續設定（Key 不會顯示）。"
else
  if [[ ! -t 0 ]]; then
    echo "這個設定必須在互動式 Terminal 執行，才能隱藏 API Key。" >&2
    exit 1
  fi

  printf "請貼上 MiniMax API Key（畫面不會顯示），再按 Enter： "
  IFS= read -r -s minimax_key
  printf "\n"
fi

if [[ -z "$minimax_key" ]]; then
  echo "未輸入 Key，.env 沒有變更。" >&2
  exit 1
fi

umask 077
tmp_file="$(mktemp "$repo_root/.env.minimax.XXXXXX")"
found=0

if [[ -f "$env_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == MINIMAX_API_KEY=* ]]; then
      printf "MINIMAX_API_KEY=%s\n" "$minimax_key" >> "$tmp_file"
      found=1
    else
      printf "%s\n" "$line" >> "$tmp_file"
    fi
  done < "$env_file"
fi

if [[ "$found" -eq 0 ]]; then
  if [[ -s "$tmp_file" ]]; then
    printf "\n" >> "$tmp_file"
  fi
  printf "MINIMAX_API_KEY=%s\n" "$minimax_key" >> "$tmp_file"
fi

mv "$tmp_file" "$env_file"
tmp_file=""
chmod 600 "$env_file"

echo "已安全寫入 ${env_file}（權限 600；Key 未顯示）。"

if command -v mmx >/dev/null 2>&1; then
  echo "正在登入 MiniMax CLI 並檢查狀態……"
  mmx auth login --api-key "$minimax_key"
  unset minimax_key
  mmx auth status
  echo "設定完成；執行 mmx 即可開始測試。"
else
  unset minimax_key
  echo "Key 已寫入；尚未安裝 mmx CLI。"
fi
