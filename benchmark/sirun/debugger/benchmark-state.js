'use strict'

const COMPLETED_PROBE_INDEX = 0
const CAPTURED_PROBE_INDEX = 1
const CAPTURE_KIND_INDEX = 2
const PROBE_COUNT_LENGTH = 3

const CAPTURE_KINDS = {
  none: 1,
  default: 2,
  minimal: 3,
}

const CAPTURE_KIND_NAMES = [undefined, 'none', 'default', 'minimal']

module.exports = {
  CAPTURED_PROBE_INDEX,
  CAPTURE_KIND_INDEX,
  CAPTURE_KIND_NAMES,
  CAPTURE_KINDS,
  COMPLETED_PROBE_INDEX,
  PROBE_COUNT_LENGTH,
}
