import { nestedEsmValue } from './nested-esm.mjs'

export function esmLabel () {
  return `esm:${nestedEsmValue()}`
}
