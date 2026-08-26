#!/bin/bash
cd "$(dirname "$0")/.."
mkdir -p qa/frames
declare -a NAMES=(01-tw-market 02-support 03-us-split 04-question 05-limitup-fact 06-demand 07-mix-shift 08-inprogress 09-turnover 10-watch 11-discipline 12-cta)
for f in "${NAMES[@]}"; do
  n="${f%%-*}"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "renders/$f.mp4")
  for tag in early:0.15 mid:0.5 hold:0.9; do
    label="${tag%%:*}"; frac="${tag##*:}"
    t=$(/opt/anaconda3/bin/python3 -c "print(round($dur*$frac,3))")
    ffmpeg -y -v error -ss "$t" -i "renders/$f.mp4" -frames:v 1 "qa/frames/$n-$label.png"
  done
done
ls qa/frames | wc -l
