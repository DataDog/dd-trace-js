const { createHistogram, PerformanceObserver } = require('perf_hooks')
if (createHistogram) {
  const StatsD = require('./statsd')
  const statsd = new StatsD()

  const histogram = createHistogram()
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      histogram.record(Math.floor(entry.duration * 1e6))
    }
  })

  observer.observe({ entryTypes: ['gc'], buffered: true })

  process.on('beforeExit', () => {
    observer.disconnect()

    statsd.gauge('gc.pause.max', histogram.max)
    statsd.flush()
  })
}
