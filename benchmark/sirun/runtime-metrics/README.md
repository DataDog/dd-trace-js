Measures the startup cost of enabling runtime metrics: `init()` wires up the
native-metrics collector, the GC PerformanceObserver, the event-loop monitor, the
dogstatsd client and the flush interval. The control vs with-metrics delta is that
wiring cost. (The old idle-window shape timed a 1s flush window rather than real
work and read as ~16% jitter; the per-collection cost is sub-millisecond and would
need the collector's private capture path exposed to measure directly.)
