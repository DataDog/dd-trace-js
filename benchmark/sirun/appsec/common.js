'use strict'

module.exports = {
  port: 3231 + parseInt(process.env.CPU_AFFINITY || '0'),
  // A larger request count keeps the per-iteration tracer+AppSec reload a
  // smaller fraction of the run so request handling dominates. Capped at 1000:
  // beyond that, WAF per-request allocations accumulate (no draining agent in
  // the bench) and per-request cost falls off a cliff. The client uses a
  // keep-alive connection so this count does not churn ephemeral ports.
  reqs: Number(process.env.REQS) || 1000,
}
