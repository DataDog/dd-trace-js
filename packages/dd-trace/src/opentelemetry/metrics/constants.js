'use strict'

// Metric type constants
const METRIC_TYPES = {
  HISTOGRAM: 'histogram',
  COUNTER: 'counter',
  UPDOWNCOUNTER: 'updowncounter',
  OBSERVABLECOUNTER: 'observable-counter',
  OBSERVABLEUPDOWNCOUNTER: 'observable-updowncounter',
  GAUGE: 'gauge'
}

// Temporality constants
const TEMPORALITY = {
  DELTA: 'DELTA',
  CUMULATIVE: 'CUMULATIVE',
  GAUGE: 'GAUGE',
  LOWMEMORY: 'LOWMEMORY'
}

// Default histogram bucket boundaries (in milliseconds for latency metrics)
const DEFAULT_HISTOGRAM_BUCKETS = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10_000]

// Maximum number of measurements to queue before dropping
// This limit corresponds to the maximum number of items
// that be reliably added to a single Array.
const DEFAULT_MAX_MEASUREMENT_QUEUE_SIZE = 65_536

module.exports = {
  METRIC_TYPES,
  TEMPORALITY,
  DEFAULT_HISTOGRAM_BUCKETS,
  DEFAULT_MAX_MEASUREMENT_QUEUE_SIZE
}
