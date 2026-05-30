# sirun benchmark overview

Local macOS, 6 samples/variant (overview-grade, not the CI gate). wall.time is microseconds in sirun; reported per-iteration in ms. "total" = mean x configured iterations. "startup%" = load+setup share from the guard.

| bench | variant | category | meaning | inner loop | iters | per-iter ms | stddev% | total s | startup% |
|---|---|---|---|---|---|---|---|---|---|
| appsec | control | live | medium | - | 30 | live (CI only) | - | - | - |
| appsec | appsec-enabled | live | medium | - | 30 | live (CI only) | - | - | - |
| appsec | appsec-enabled-with-attacks | live | medium | - | 30 | live (CI only) | - | - | - |
| appsec | startup-time-control | live | medium | - | 30 | error | - | - | - |
| appsec | startup-time-appsec-enabled | live | medium | - | 30 | error | - | - | - |
| appsec-iast | no-vulnerability-control | live | medium | - | 15 | live (CI only) | - | - | - |
| appsec-iast | no-vulnerability-iast-enabled-default-config | live | medium | - | 15 | live (CI only) | - | - | - |
| appsec-iast | no-vulnerability-iast-enabled-always-active | live | medium | - | 15 | live (CI only) | - | - | - |
| appsec-iast | with-vulnerability-control | live | medium | - | 15 | live (CI only) | - | - | - |
| appsec-iast | with-vulnerability-iast-enabled-default-config | live | medium | - | 15 | live (CI only) | - | - | - |
| appsec-iast | with-vulnerability-iast-enabled-always-active | live | medium | - | 15 | live (CI only) | - | - | - |
| appsec-iast | startup-time-control | live | medium | - | 15 | error | - | - | - |
| appsec-iast | startup-time-iast-enabled | live | medium | - | 15 | error | - | - | - |
| async_hooks | init-only | critical-path | high | - | 24 | 179.4 | 1.2 | 4 | 0.1 |
| async_hooks | all-hooks | critical-path | high | - | 24 | 992.0 | 4.5 | 24 | 0.0 |
| child_process | shell-string | real-world-plugin | medium | 20000000 | 15 | 982.5 | 1.0 | 15 | 0.2 |
| child_process | file-args | real-world-plugin | medium | 11000000 | 15 | 988.5 | 0.7 | 15 | 0.2 |
| datastreams | produce | real-world-plugin | medium | - | 30 | 930.0 | 1.0 | 28 | 1.8 |
| datastreams | consume | real-world-plugin | medium | - | 30 | 1035.5 | 0.3 | 31 | 1.6 |
| datastreams | produce-with-message-size | real-world-plugin | medium | - | 30 | 1136.3 | 1.6 | 34 | 1.6 |
| datastreams | produce-manual-checkpoint | real-world-plugin | medium | - | 30 | 954.2 | 0.7 | 29 | 1.7 |
| datastreams | produce-high-cardinality | real-world-plugin | medium | - | 30 | 1051.4 | 0.9 | 32 | 1.6 |
| debugger | enabled-but-breakpoint-not-hit | background | medium | - | 10 | live (CI only) | - | - | - |
| debugger | line-probe-without-snapshot | background | medium | - | 10 | live (CI only) | - | - | - |
| debugger | line-probe-with-snapshot-default | background | medium | - | 10 | live (CI only) | - | - | - |
| debugger | line-probe-with-snapshot-minimal | background | medium | - | 10 | live (CI only) | - | - | - |
| encoding | 0.4 | critical-path | high | - | 20 | 1790.4 | 7.0 | 36 | 1.0 |
| encoding | 0.5 | critical-path | high | - | 20 | 864.9 | 1.7 | 17 | 2.1 |
| encoding | 0.4-events-native | critical-path | high | - | 20 | 1576.5 | 4.7 | 32 | 1.1 |
| encoding | 0.4-events-legacy | critical-path | high | - | 20 | 2365.6 | 2.0 | 47 | 0.8 |
| encoding | 0.5-events-legacy | critical-path | high | - | 20 | 1831.6 | 0.4 | 37 | 0.9 |
| encoding | 0.4-wide-tags | critical-path | high | - | 20 | 1727.8 | 1.4 | 35 | 1.1 |
| encoding | 0.5-wide-tags | critical-path | high | - | 20 | 1606.7 | 2.6 | 32 | 1.2 |
| exporting-pipeline | format | critical-path | high | 200000 | 20 | 858.2 | 0.7 | 17 | 1.4 |
| exporting-pipeline | format-with-stats | critical-path | high | 200000 | 20 | 883.1 | 1.5 | 18 | 2.4 |
| exporting-pipeline | format-with-links-events | critical-path | high | 85000 | 20 | 1032.7 | 0.6 | 21 | 1.1 |
| fs | subscribed | real-world-plugin | high | 22000000 | 15 | 2116.1 | 1.0 | 32 | 0.1 |
| iast | request-lifecycle | real-world-plugin | medium | 8000 | 15 | 1791.3 | 0.3 | 27 | 0.8 |
| iast | sink-check | real-world-plugin | medium | 5000000 | 15 | 1549.3 | 6.2 | 23 | 0.9 |
| id | generate | critical-path | high | 80000000 | 15 | 820.9 | 1.2 | 12 | 0.2 |
| id | parse-64bit | critical-path | high | 6000000 | 15 | 1041.1 | 0.5 | 16 | 0.1 |
| id | parse-128bit | critical-path | high | 3000000 | 15 | 1086.8 | 1.2 | 16 | 0.1 |
| llmobs | encode-unicode-ascii | background | medium | - | 5 | 563.5 | 1.2 | 3 | - |
| llmobs | encode-unicode-mixed | background | medium | - | 5 | 5155.0 | 1.0 | 26 | - |
| log | without-log | background | medium | 200000000 | 10 | 280.2 | 2.9 | 3 | 2.8 |
| log | skip-log | background | medium | 200000000 | 10 | 300.5 | 2.1 | 3 | 2.3 |
| log | with-debug | background | medium | 3000000 | 10 | 1289.9 | 4.0 | 13 | 0.5 |
| log | with-error | background | medium | 1000000 | 10 | 2695.8 | 1.4 | 27 | 0.3 |
| plugin-aws-sdk | extract-response-body | real-world-plugin | medium | 8000000 | 10 | 791.7 | 2.5 | 8 | 1.8 |
| plugin-aws-sdk | eventbridge-inject-detail | real-world-plugin | medium | - | 10 | 791.0 | 1.8 | 8 | 1.9 |
| plugin-aws-sdk | lambda-inject-no-context | real-world-plugin | medium | - | 10 | 699.7 | 1.2 | 7 | 2.3 |
| plugin-dns | with-tracer | real-world-plugin | low | 10000 | 20 | 1434.3 | 2.3 | 29 | 5.0 |
| plugin-graphql-long | with-depth-off | real-world-plugin | medium | 1500 | 10 | 2363.3 | 2.3 | 24 | 5.5 |
| plugin-graphql-long | with-depth-on-max | real-world-plugin | medium | 1500 | 10 | 2877.3 | 0.7 | 29 | 3.2 |
| plugin-graphql-long | with-depth-and-collapse-off | real-world-plugin | medium | 600 | 10 | 3535.4 | 1.7 | 35 | 2.6 |
| plugin-http | client-with-tracer | live | medium | - | 20 | live (CI only) | - | - | - |
| plugin-http | server-with-tracer | live | medium | - | 20 | live (CI only) | - | - | - |
| plugin-http | server-querystring-obfuscation | live | medium | - | 20 | live (CI only) | - | - | - |
| plugin-kafkajs | small | real-world-plugin | medium | 8500000 | 15 | 1649.6 | 0.4 | 25 | 0.5 |
| plugin-kafkajs | large | real-world-plugin | medium | 5500000 | 15 | 1747.0 | 0.5 | 26 | 0.5 |
| plugin-kafkajs | mixed | real-world-plugin | medium | 7000000 | 15 | 1677.4 | 0.4 | 25 | 0.6 |
| plugin-mongodb-core | plain-find | real-world-plugin | medium | 11000000 | 15 | 1677.3 | 0.7 | 25 | 0.6 |
| plugin-mongodb-core | deep-aggregate | real-world-plugin | medium | 1600000 | 15 | 1790.4 | 1.1 | 27 | 0.5 |
| plugin-mongodb-core | bigint-id | real-world-plugin | medium | 5500000 | 15 | 1612.0 | 0.5 | 24 | 0.7 |
| plugin-mongodb-core | binary-hash | real-world-plugin | medium | 4500000 | 15 | 1068.6 | 0.6 | 16 | 0.9 |
| plugin-mongodb-core | mixed-ops | real-world-plugin | medium | 5000000 | 15 | 1570.6 | 0.5 | 24 | 0.6 |
| plugin-net | with-tracer | live | medium | - | 30 | live (CI only) | - | - | - |
| plugin-pg | service | real-world-plugin | medium | 14000000 | 15 | 1565.1 | 0.6 | 23 | 0.7 |
| plugin-pg | full | real-world-plugin | medium | 14000000 | 15 | 2013.5 | 2.1 | 30 | 0.6 |
| plugin-pino | json-log-injection | real-world-plugin | medium | 5000000 | 10 | 1090.6 | 0.5 | 11 | 0.2 |
| plugin-redis | get | real-world-plugin | medium | 20000000 | 15 | 1904.4 | 0.6 | 29 | 0.6 |
| plugin-redis | long-value | real-world-plugin | medium | 13000000 | 15 | 1440.1 | 0.6 | 22 | 0.7 |
| plugin-redis | mset-wide | real-world-plugin | medium | 2200000 | 15 | 1759.7 | 1.2 | 26 | 0.6 |
| plugin-redis | mixed | real-world-plugin | medium | 13000000 | 15 | 1510.2 | 0.3 | 23 | 0.6 |
| plugin-ws | pointer-only | real-world-plugin | medium | 16000000 | 15 | 1668.1 | 0.6 | 25 | 0.1 |
| plugin-ws | pointer-and-link | real-world-plugin | medium | 13000000 | 15 | 1679.0 | 0.5 | 25 | 0.1 |
| profiler | control | background | medium | - | 5 | 115.7 | 9.5 | 1 | - |
| profiler | with-cpu-profiler | background | medium | - | 5 | 139.6 | 1.8 | 1 | - |
| profiler | with-space-profiler | background | medium | - | 5 | 117.9 | 1.2 | 1 | - |
| profiler | with-all-profilers | background | medium | - | 5 | 141.5 | 1.2 | 1 | - |
| propagation | extract | critical-path | high | - | 10 | 770.7 | 4.1 | 8 | 1.8 |
| propagation | inject | critical-path | high | - | 10 | 411.5 | 1.4 | 4 | 3.2 |
| propagation | extract-baggage-percent | critical-path | high | - | 10 | 859.7 | 1.4 | 9 | 1.6 |
| runtime-metrics | control | background | medium | - | 15 | 96.4 | 1.6 | 1 | - |
| runtime-metrics | with-runtime-metrics | background | medium | - | 15 | 99.6 | 1.8 | 1 | - |
| scope | base | critical-path | high | 100000000 | 10 | 1604.2 | 1.0 | 16 | 0.0 |
| scope | scope_enabled | critical-path | high | 4000000 | 10 | 1937.5 | 2.7 | 19 | 0.0 |
| scope | bind | critical-path | high | 3000000 | 10 | 1368.0 | 1.8 | 14 | 0.1 |
| shimmer-runtime | declared-wrap | critical-path | high | 1000000000 | 10 | 916.2 | 1.7 | 9 | 0.1 |
| shimmer-runtime | declared-wrapfn | critical-path | high | 1000000000 | 10 | 908.2 | 2.1 | 9 | 0.1 |
| shimmer-startup | declared-wrap | critical-path | high | 1000000 | 20 | 530.8 | 0.7 | 11 | 0.1 |
| shimmer-startup | declared-wrapfn | critical-path | high | 1000000 | 20 | 522.3 | 1.1 | 10 | 0.1 |
| spans | finish-immediately | critical-path | high | 2000000 | 20 | 667.4 | 4.0 | 13 | 12.0 |
| spans | finish-later | critical-path | high | 2000000 | 20 | 738.7 | 1.0 | 15 | 9.9 |
| spans | finish-immediately-with-tags | critical-path | high | 2000000 | 20 | 767.5 | 0.9 | 15 | 9.7 |
| spans | finish-immediately-with-many-tags | critical-path | high | 2000000 | 20 | 1694.7 | 0.9 | 34 | 4.2 |
| spans | finish-immediately-with-tags-and-otel | critical-path | high | 2000000 | 20 | 1038.5 | 0.9 | 21 | 7.1 |
| startup | with-tracer | critical-path | high | - | 20 | 97.6 | 2.2 | 2 | - |
| startup | with-tracer-everything | critical-path | high | - | 20 | error | - | - | - |
| url | endpoint-and-obfuscation | real-world-plugin | high | 3500000 | 10 | 2497.2 | 1.1 | 25 | 0.1 |
