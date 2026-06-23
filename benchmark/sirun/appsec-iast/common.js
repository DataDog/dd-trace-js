'use strict'

module.exports = {
  port: 3331 + parseInt(process.env.CPU_AFFINITY || '0'),
  // Env-tunable like the other live benches. Local tuning (keep-alive, higher
  // counts) did not reduce the run-to-run jitter -- it is express/IAST scheduling
  // noise that CI core-pinning addresses, not connection churn -- so this is left
  // at a modest default and gated on CI.
  reqs: Number(process.env.OPERATIONS),
}
