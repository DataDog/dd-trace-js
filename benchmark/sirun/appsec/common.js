'use strict'

module.exports = {
  port: 3231 + parseInt(process.env.CPU_AFFINITY || '0'),
  reqs: 100
}
