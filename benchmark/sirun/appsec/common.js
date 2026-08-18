'use strict'

module.exports = {
  port: 3231 + parseInt(process.env.CPU_AFFINITY || '0', 10),
  reqs: Number(process.env.OPERATIONS) || 1000,
  warmup: 100,
}
