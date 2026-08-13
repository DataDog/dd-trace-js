'use strict'

const affinity = Number.parseInt(process.env.CPU_AFFINITY || '0', 10)

module.exports = {
  // Offset by affinity so parallel sirun runs on different cores do not collide.
  appPort: 3051 + affinity * 2,
  agentPort: 3052 + affinity * 2,
  // A large request count keeps the per-iteration node/tracer startup a small
  // fraction of the run, so the measurement is dominated by the request path. Safe
  // to be large because the client reuses one keep-alive connection.
  reqs: Number(process.env.REQS) || 8000,
}
