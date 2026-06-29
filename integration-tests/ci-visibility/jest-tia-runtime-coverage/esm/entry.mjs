import math from '../src/math.js'

import { esmLabel } from './shared-esm.mjs'

export function esmAggregate (name) {
  return `${name}:${esmLabel()}:${math.multiply(2, 3)}`
}
