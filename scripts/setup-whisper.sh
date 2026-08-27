#!/bin/bash
# 下載 ASR 模型。57MB，不進版控。
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)/.cache/whisper"
MODEL="$DIR/ggml-base-q5_1.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
if [ -f "$MODEL" ]; then echo "已存在：$MODEL"; exit 0; fi
command -v whisper-cli >/dev/null || { echo "缺 whisper-cli。裝：brew install whisper-cpp"; exit 1; }
mkdir -p "$DIR"
echo "下載 $URL"
curl -fL --progress-bar -o "$MODEL" "$URL"
ls -lh "$MODEL"
