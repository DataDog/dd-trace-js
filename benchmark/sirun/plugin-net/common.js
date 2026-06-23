'use strict'

module.exports = {
  port: 3131 + parseInt(process.env.CPU_AFFINITY || '0'),
  // A larger request count keeps the per-iteration tracer load a small fraction
  // of the run so the measurement is dominated by the TCP round-trips. Kept
  // conservative: the echo server counts raw connections, so an over-high count
  // risks a connection-level glitch desyncing client/server and stalling.
  reqs: Number(process.env.REQS) || 600,
}
