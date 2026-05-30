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
| async_hooks | init-only | critical-path | high | - | 24 | 193.2 | 2.3 | 5 | 0.1 |
| async_hooks | all-hooks | critical-path | high | - | 24 | 1114.8 | 9.4 | 27 | 0.0 |
| child_process | shell-string | real-world-plugin | medium | 20000000 | 15 | 984.4 | 1.6 | 15 | 0.2 |
| child_process | file-args | real-world-plugin | medium | 11000000 | 15 | 994.7 | 1.1 | 15 | 0.2 |
| datastreams | produce | real-world-plugin | medium | - | 30 | 942.6 | 0.9 | 28 | 1.8 |
| datastreams | consume | real-world-plugin | medium | - | 30 | 1072.9 | 4.4 | 32 | 1.6 |
| datastreams | produce-with-message-size | real-world-plugin | medium | - | 30 | 1153.8 | 1.1 | 35 | 1.4 |
| datastreams | produce-manual-checkpoint | real-world-plugin | medium | - | 30 | 970.5 | 0.7 | 29 | 1.8 |
| datastreams | produce-high-cardinality | real-world-plugin | medium | - | 30 | 1075.7 | 0.9 | 32 | 1.7 |
| debugger | enabled-but-breakpoint-not-hit | background | medium | - | 10 | live (CI only) | - | - | - |
| debugger | line-probe-without-snapshot | background | medium | - | 10 | live (CI only) | - | - | - |
| debugger | line-probe-with-snapshot-default | background | medium | - | 10 | live (CI only) | - | - | - |
| debugger | line-probe-with-snapshot-minimal | background | medium | - | 10 | live (CI only) | - | - | - |
| encoding | 0.4 | critical-path | high | - | 10 | 1860.4 | 14.0 | 19 | 1.0 |
| encoding | 0.5 | critical-path | high | - | 10 | 877.0 | 1.1 | 9 | 2.2 |
| encoding | 0.4-events-native | critical-path | high | - | 10 | 1570.2 | 1.5 | 16 | 1.1 |
| encoding | 0.4-events-legacy | critical-path | high | - | 10 | 2381.2 | 1.2 | 24 | 0.8 |
| encoding | 0.5-events-legacy | critical-path | high | - | 10 | 1854.8 | 0.7 | 19 | 1.0 |
| encoding | 0.4-wide-tags | critical-path | high | - | 10 | 1741.1 | 1.7 | 17 | 1.1 |
| encoding | 0.5-wide-tags | critical-path | high | - | 10 | 1618.3 | 2.8 | 16 | 1.1 |
| exporting-pipeline | format | critical-path | high | 200000 | 20 | 873.5 | 1.4 | 17 | 1.4 |
| exporting-pipeline | format-with-stats | critical-path | high | 200000 | 20 | 886.1 | 1.1 | 18 | 2.3 |
| exporting-pipeline | format-with-links-events | critical-path | high | 85000 | 20 | 1034.7 | 0.8 | 21 | 1.2 |
| fs | subscribed | real-world-plugin | high | 22000000 | 15 | 2108.5 | 0.9 | 32 | 0.1 |
| iast | request-lifecycle | real-world-plugin | medium | 8000 | 15 | 1781.7 | 0.3 | 27 | 0.8 |
| iast | sink-check | real-world-plugin | medium | 5000000 | 15 | 1546.5 | 5.2 | 23 | 0.9 |
| id | generate | critical-path | high | 80000000 | 15 | 814.5 | 1.2 | 12 | 0.2 |
| id | parse-64bit | critical-path | high | 6000000 | 15 | 1046.6 | 0.8 | 16 | 0.1 |
| id | parse-128bit | critical-path | high | 3000000 | 15 | 1084.7 | 1.5 | 16 | 0.1 |
| llmobs | encode-unicode-ascii | background | medium | - | 5 | 559.7 | 0.6 | 3 | - |
| llmobs | encode-unicode-mixed | background | medium | - | 5 | 5184.4 | 0.3 | 26 | - |
| log | without-log | background | medium | - | 10 | 33.7 | 4.4 | 0 | - |
| log | skip-log | background | medium | - | 10 | 32.8 | 2.7 | 0 | - |
| log | with-debug | background | medium | - | 10 | 462.2 | 1.8 | 5 | - |
| log | with-error | background | medium | - | 10 | 2709.9 | 2.0 | 27 | - |
| plugin-aws-sdk | extract-response-body | real-world-plugin | medium | - | 10 | 227.7 | 2.0 | 2 | 7.5 |
| plugin-aws-sdk | eventbridge-inject-detail | real-world-plugin | medium | - | 10 | 771.5 | 0.5 | 8 | 1.9 |
| plugin-aws-sdk | lambda-inject-no-context | real-world-plugin | medium | - | 10 | 690.5 | 0.4 | 7 | 2.3 |
| plugin-dns | with-tracer | real-world-plugin | low | 10000 | 20 | 1497.1 | 3.1 | 30 | 4.9 |
| plugin-graphql-long | with-depth-off | real-world-plugin | medium | 1500 | 10 | 2677.3 | 3.3 | 27 | 3.5 |
| plugin-graphql-long | with-depth-on-max | real-world-plugin | medium | 1500 | 10 | 3554.2 | 3.8 | 36 | 2.7 |
| plugin-graphql-long | with-depth-and-collapse-off | real-world-plugin | medium | 1500 | 10 | 9844.5 | 3.3 | 98 | 1.0 |
| plugin-http | client-with-tracer | live | medium | - | 20 | live (CI only) | - | - | - |
| plugin-http | server-with-tracer | live | medium | - | 20 | live (CI only) | - | - | - |
| plugin-http | server-querystring-obfuscation | live | medium | - | 20 | live (CI only) | - | - | - |
| plugin-kafkajs | small | real-world-plugin | medium | 8500000 | 15 | 1677.3 | 2.0 | 25 | 0.6 |
| plugin-kafkajs | large | real-world-plugin | medium | 5500000 | 15 | 1768.5 | 0.6 | 27 | 0.6 |
| plugin-kafkajs | mixed | real-world-plugin | medium | 7000000 | 15 | 1714.3 | 1.3 | 26 | 0.6 |
| plugin-mongodb-core | plain-find | real-world-plugin | medium | 11000000 | 15 | 1702.3 | 1.2 | 26 | 0.6 |
| plugin-mongodb-core | deep-aggregate | real-world-plugin | medium | 1600000 | 15 | 1800.7 | 0.7 | 27 | 0.6 |
| plugin-mongodb-core | bigint-id | real-world-plugin | medium | 11000000 | 15 | 3331.2 | 4.8 | 50 | 0.3 |
| plugin-mongodb-core | binary-hash | real-world-plugin | medium | 4500000 | 15 | 1090.7 | 1.0 | 16 | 0.9 |
| plugin-mongodb-core | mixed-ops | real-world-plugin | medium | 5000000 | 15 | 1583.4 | 0.6 | 24 | 0.6 |
| plugin-net | with-tracer | live | medium | - | 30 | live (CI only) | - | - | - |
| plugin-pg | service | real-world-plugin | medium | 14000000 | 15 | 1560.0 | 0.4 | 23 | 0.8 |
| plugin-pg | full | real-world-plugin | medium | 14000000 | 15 | 1997.6 | 0.6 | 30 | 0.6 |
| plugin-pino | json-log-injection | real-world-plugin | medium | 5000000 | 10 | 1093.9 | 0.6 | 11 | 0.2 |
| plugin-redis | get | real-world-plugin | medium | 20000000 | 15 | 1920.6 | 0.5 | 29 | 0.5 |
| plugin-redis | long-value | real-world-plugin | medium | 13000000 | 15 | 1459.7 | 0.6 | 22 | 0.7 |
| plugin-redis | mset-wide | real-world-plugin | medium | 2200000 | 15 | 1774.0 | 2.0 | 27 | 0.5 |
| plugin-redis | mixed | real-world-plugin | medium | 13000000 | 15 | 1524.7 | 0.6 | 23 | 0.7 |
| plugin-ws | pointer-only | real-world-plugin | medium | 16000000 | 15 | 1676.0 | 0.4 | 25 | 0.1 |
| plugin-ws | pointer-and-link | real-world-plugin | medium | 13000000 | 15 | 1687.5 | 0.8 | 25 | 0.1 |
| profiler | control | background | medium | - | 5 | 118.0 | 8.5 | 1 | - |
| profiler | with-cpu-profiler | background | medium | - | 5 | 143.6 | 1.4 | 1 | - |
| profiler | with-space-profiler | background | medium | - | 5 | 120.8 | 1.8 | 1 | - |
| profiler | with-all-profilers | background | medium | - | 5 | 144.1 | 0.7 | 1 | - |
| propagation | extract | critical-path | high | - | 10 | 782.8 | 1.5 | 8 | 1.8 |
| propagation | inject | critical-path | high | - | 10 | 412.0 | 0.6 | 4 | 3.4 |
| propagation | extract-baggage-percent | critical-path | high | - | 10 | 863.1 | 0.6 | 9 | 1.5 |
| runtime-metrics | control | background | medium | - | 5 | 1098.0 | 0.1 | 5 | - |
| runtime-metrics | with-runtime-metrics | background | medium | - | 5 | 1181.6 | 16.6 | 6 | - |
| scope | base | critical-path | high | 100000000 | 10 | 1649.7 | 6.0 | 16 | 0.0 |
| scope | scope_enabled | critical-path | high | 8000000 | 10 | 4088.9 | 2.5 | 41 | 0.0 |
| scope | bind | critical-path | high | 3000000 | 10 | 1483.2 | 2.3 | 15 | 0.0 |
| shimmer-runtime | declared-wrap | critical-path | high | 400000000 | 10 | 386.1 | 2.1 | 4 | 0.1 |
| shimmer-runtime | declared-wrapfn | critical-path | high | 1000000000 | 10 | 919.1 | 1.4 | 9 | 0.1 |
| shimmer-startup | declared-wrap | critical-path | high | 1000000 | 20 | 537.3 | 0.9 | 11 | 0.1 |
| shimmer-startup | declared-wrapfn | critical-path | high | 1000000 | 20 | 540.1 | 3.8 | 11 | 0.1 |
| spans | finish-immediately | critical-path | high | 2000000 | 20 | 674.3 | 1.6 | 13 | 11.2 |
| spans | finish-later | critical-path | high | 2000000 | 20 | 747.0 | 1.3 | 15 | 10.1 |
| spans | finish-immediately-with-tags | critical-path | high | 2000000 | 20 | 781.0 | 0.9 | 16 | 9.7 |
| spans | finish-immediately-with-many-tags | critical-path | high | 2000000 | 20 | 1705.4 | 0.5 | 34 | 4.3 |
| spans | finish-immediately-with-tags-and-otel | critical-path | high | 2000000 | 20 | 1059.4 | 1.9 | 21 | 7.0 |
| startup | with-tracer | critical-path | high | - | 20 | 98.7 | 1.9 | 2 | - |
| startup | with-tracer-everything | critical-path | high | - | 20 | error | - | - | - |
| url | endpoint-and-obfuscation | real-world-plugin | high | 7000000 | 10 | 4954.9 | 0.6 | 50 | 0.0 |
