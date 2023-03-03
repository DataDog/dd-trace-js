'use strict'

const processStartTime = BigInt(Date.now() * 1e6)
const processStartTicks = process.hrtime.bigint()

function now () {
  Number(processStartTime + process.hrtime.bigint() - processStartTicks)
}

module.exports = { now }
