import { describe, test } from 'vitest'

import { noAutoRetry } from 'dd-trace/ci/test-annotations'

/**
 * @param {typeof import('vitest').test} api
 * @param {string} label
 */
function declare (api, label) {
  const prepareStackTrace = Error.prepareStackTrace
  if (globalThis.process?.env?.EXCLUSIONS_MODE === 'locations-no-stack') {
    Error.prepareStackTrace = () => 'stack unavailable'
  }
  try {
    const pass = () => {}
    const annotated = noAutoRetry(pass)
    api(`${label} direct plain`, pass) // location: direct plain
    api(`${label} direct annotated`, annotated) // location: direct annotated
    const each = api.each([1])
    each(`${label} each plain %s`, pass) // location: each plain 1
    each(`${label} each annotated %s`, annotated) // location: each annotated 1
    const concurrent = api.concurrent.each([1])
    concurrent(`${label} concurrent plain %s`, pass) // location: concurrent plain 1
    concurrent(`${label} concurrent annotated %s`, annotated) // location: concurrent annotated 1
    const extended = api.extend({ value: 1 })
    const extendedCases = extended.each([1])
    extendedCases(`${label} extended plain %s`, pass) // location: extended plain 1
    extendedCases(`${label} extended annotated %s`, annotated) // location: extended annotated 1
    const nested = extended.extend({ other: 2 })
    const nestedCases = nested.each([1])
    const limit = Error.stackTraceLimit
    try {
      Error.stackTraceLimit = 0
      nestedCases(`${label} nested plain %s`, pass) // location: nested plain 1
      nestedCases(`${label} nested annotated %s`, annotated) // location: nested annotated 1
      if (Error.stackTraceLimit !== 0) throw new Error('Declaration changed the stack trace limit')
    } finally {
      Error.stackTraceLimit = limit
    }
    const skipped = api.skip.each([1])
    skipped(`${label} skipped plain %s`, pass) // location: skipped plain 1
    skipped(`${label} skipped annotated %s`, annotated) // location: skipped annotated 1
    const conditional = api.skipIf(false).runIf(true)
    const conditionalCases = conditional.each([1])
    conditionalCases(`${label} conditional plain %s`, pass) // location: conditional plain 1
    conditionalCases(`${label} conditional annotated %s`, annotated) // location: conditional annotated 1
    if (api.for) {
      const forCases = api.for([1])
      forCases(`${label} for plain %s`, pass) // location: for plain 1
      forCases(`${label} for annotated %s`, annotated) // location: for annotated 1
    }
  } finally {
    Error.prepareStackTrace = prepareStackTrace
  }
}

declare(test, 'global')
describe('local', localTest => declare(localTest, 'local'))
