'use strict'

module.exports = {
  port: 3231 + parseInt(process.env.CPU_AFFINITY || '0'),
  // Requests per iteration, sized per variant in meta.json (OPERATIONS). A higher count
  // dilutes the fixed startup (node boot + tracer/AppSec init), which is otherwise
  // a large, run-to-run-variable share of a short run and dominates stddev (control
  // drifted 290-440 ms between runs at 1000). It can't just be maximized: with no
  // draining agent, spans (control) and WAF events (AppSec on) accumulate, so each
  // variant has a GC cliff above which stddev explodes (control ~8000). Each OPERATIONS
  // sits in its variant's valley -- diluted startup, below the cliff, under ~45 s
  // at 30 iterations. The keep-alive client avoids ephemeral-port churn.
  reqs: Number(process.env.OPERATIONS),
}
