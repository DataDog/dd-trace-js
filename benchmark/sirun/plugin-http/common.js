'use strict'

module.exports = {
  port: 3031 + parseInt(process.env.CPU_AFFINITY || '0'),
  // A large request count keeps the per-iteration node/tracer startup a small
  // fraction of the run so the measurement is dominated by the HTTP round-trips.
  // Safe to be large because the client reuses one keep-alive connection.
  reqs: Number(process.env.OPERATIONS),
}
