#!/bin/bash
cd "$(dirname "$0")/.."
declare -a NAMES=(02-market-split 04-demand-chain 06-time-gap 08-watch-two)
for f in "${NAMES[@]}"; do
  n="${f%%-*}"; d="qa/slot$n"
  mkdir -p "$d"; cp "compositions/$f.html" "$d/index.html"
  ln -sfn ../../assets "$d/assets"; cp hyperframes.json "$d/"
  printf "slot %s  " "$n"
  npx --yes hyperframes@0.8.3 check "$d" --json 2>/dev/null | /opt/anaconda3/bin/python3 -c "
import json,sys
t=sys.stdin.read(); i=t.find('{'); d=json.loads(t[i:])
E=sum((d.get(k) or {}).get('errorCount',0) for k in ['lint','runtime','layout','motion','contrast'])
W=sum((d.get(k) or {}).get('warningCount',0) for k in ['lint','runtime','layout','motion','contrast'])
print('ok=',d.get('ok'),' 錯',E,' 警',W)
for k in ['lint','runtime','layout','motion','contrast']:
    for fx in ((d.get(k) or {}).get('findings') or []):
        if fx.get('severity')=='error': print('   ERR',k,fx.get('code'),fx.get('selector'))
"
done
