#!/bin/bash
# Per-check table: Node version x V8 tier. Node 22 runs twice: default (async_hooks ALS) and with ACF.
cd ~/attribution-spike/b
has () { "$1" --v8-options | grep -q -- "^  --$2 "; }
N22=$(command -v node)
D=$HOME/attribution-spike/node
for spec in $D/node-v18.20.8-linux-x64/bin/node $D/node-v20.20.2-linux-x64/bin/node $N22 $N22:ACF $D/node-v24.22.3-linux-x64/bin/node; do
  n=${spec%%:*}; extra=""; [ "$spec" != "$n" ] && extra="--experimental-async-context-frame"
  noopt="--no-opt"; has $n turbofan && noopt="--no-turbofan"
  nomag=""; has $n maglev && nomag="--no-maglev"
  for tier in ignition sparkplug maglev turbofan; do
    case $tier in
      ignition) f="--no-sparkplug $nomag $noopt"; N=3000000;;
      sparkplug) f="--sparkplug --always-sparkplug $nomag $noopt"; N=5000000;;
      maglev) has $n maglev || { echo "{\"tier\":\"maglev\"} {\"node\":\"$($n -v)\",\"na\":true}"; continue; }; f="--maglev $noopt"; N=20000000;;
      turbofan) f=""; N=50000000;;
    esac
    echo -n "{\"tier\":\"$tier\",\"flags\":\"$extra $f\"} "
    $n $extra $f bench.js $N 11
  done
done
