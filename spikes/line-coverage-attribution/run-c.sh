#!/bin/bash
# C (addon) vs B (raw ALS getStore) per tier, on the runtimes where ALS lives in CPED.
N24=$HOME/attribution-spike/node/node-v24.22.3-linux-x64/bin/node
for spec in "$N24:$HOME/attribution-spike/c:" "$(command -v node):$HOME/attribution-spike/c22:--experimental-async-context-frame"; do
  IFS=: read -r n dir extra <<< "$spec"
  cd "$dir"
  for tier in ignition sparkplug maglev turbofan; do
    case $tier in
      ignition) f="--no-sparkplug --no-maglev --no-turbofan"; N=3000000;;
      sparkplug) f="--sparkplug --always-sparkplug --no-maglev --no-turbofan"; N=5000000;;
      maglev) f="--maglev --no-turbofan"; N=20000000;;
      turbofan) f=""; N=50000000;;
    esac
    echo -n "{\"tier\":\"$tier\",\"flags\":\"$extra $f\"} "
    $n $extra $f bench-c.js $N 11
  done
done
