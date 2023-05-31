'use strict'

module.exports = {
  port: 3031 + parseInt(process.env.CPU_AFFINITY || '0'),
  reqs: 350
}
