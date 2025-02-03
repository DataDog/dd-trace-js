'use strict'

const { SAMPLING_MECHANISM_APPSEC } = require('../constants')

module.exports = {
  APM: { id: 1 << 0 },
  ASM: { id: 1 << 1, mechanism: SAMPLING_MECHANISM_APPSEC },
  DSM: { id: 1 << 2 },
  DJM: { id: 1 << 3 },
  DBM: { id: 1 << 4 }
}
