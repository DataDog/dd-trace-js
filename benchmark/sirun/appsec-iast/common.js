'use strict'

module.exports = {
  port: 3331 + parseInt(process.env.CPU_AFFINITY || '0'),
  // Env-tunable like the other live benches. The with-vulnerability server runs
  // a real child_process.exec per request, so raising this trades startup-share
  // for subprocess-spawn noise; tune per variant on CI (see README) rather than
  // pushing a single high default here.
  reqs: Number(process.env.REQS) || 100,
}
