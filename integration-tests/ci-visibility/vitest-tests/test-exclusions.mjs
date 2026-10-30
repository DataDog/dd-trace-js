import { appendFileSync } from 'node:fs'

import { describe, test } from 'vitest'
import { preventFailureSuppression, noAutoRetry } from 'dd-trace/test-optimization.js'

function fail () { throw new Error('excluded failure') }

function tracked (name, callback = fail) {
  return function () {
    if (process.env.EXCLUSIONS_LEDGER) {
      appendFileSync(process.env.EXCLUSIONS_LEDGER, JSON.stringify(name) + '\n')
    }
    return callback.apply(this, arguments)
  }
}

if (process.env.EXCLUSIONS_MODE === 'policy') {
  test('protected disabled', preventFailureSuppression(tracked('protected disabled')))
  test('protected quarantine', preventFailureSuppression(tracked('protected quarantine')))
  const protectedCases = test.each([1, 2])
  protectedCases('protected both %s', preventFailureSuppression(noAutoRetry(tracked('protected both'))))
  test('ordinary disabled', noAutoRetry(tracked('ordinary disabled')))
  test('ordinary quarantine', noAutoRetry(tracked('ordinary quarantine')))
  test('protected passing', preventFailureSuppression(tracked('protected passing', () => {})))
  test.skip('developer skipped', preventFailureSuppression(noAutoRetry(tracked('developer skipped'))))
} else if (process.env.EXCLUSIONS_MODE === 'tagged-table') {
  const cases = test.each`
    row | callback
    ${1} | ${noAutoRetry(() => {})}
    ${2} | ${noAutoRetry(() => {})}
  `
  cases('tagged $row', preventFailureSuppression(noAutoRetry(tracked('tagged'))))
} else if (process.env.EXCLUSIONS_MODE === 'sole') {
  test('sole', preventFailureSuppression(noAutoRetry(tracked('sole'))))
} else if (process.env.EXCLUSIONS_MODE === 'protection-only') {
  test('sole', preventFailureSuppression(tracked('sole')))
} else if (process.env.EXCLUSIONS_MODE === 'removed') {
  test('sole', tracked('sole'))
} else if (process.env.EXCLUSIONS_MODE === 'native-tags') {
  let directExecutions = 0
  test('native tagged retries', { tags: 'flaky' }, noAutoRetry(tracked('direct', () => {
    if (++directExecutions === 1) fail()
  })))
  describe('inherited tags', { tags: 'flaky' }, () => {
    let inheritedExecutions = 0
    test('native inherited retries', noAutoRetry(tracked('inherited', () => {
      if (++inheritedExecutions === 1) fail()
    })))
  })
} else if (process.env.EXCLUSIONS_MODE === 'plain-tags') {
  test('excluded tagged', { tags: 'plain' }, noAutoRetry(tracked('excluded tagged')))
  test('control tagged', { tags: 'plain' }, tracked('control tagged'))
} else if (process.env.EXCLUSIONS_MODE === 'native-suite') {
  describe('suite retries', { retry: 2 }, () => {
    let executions = 0
    test('native retries', noAutoRetry(tracked('native retries', () => { if (++executions === 1) fail() })))
  })
} else if (process.env.EXCLUSIONS_MODE === 'native-persistent') {
  test('direct native failure', { retry: 1 }, noAutoRetry(tracked('direct')))
  describe('inherited budget', { retry: 1 }, () => {
    test('inherited native failure', noAutoRetry(tracked('inherited')))
  })
  if (process.env.EXCLUSIONS_NATIVE_QUARANTINED !== '1') test('control', tracked('control'))
} else if (process.env.EXCLUSIONS_MODE === 'collision') {
  const shared = tracked('shared')
  test.concurrent('collision', noAutoRetry(shared))
  test.concurrent('collision', shared)
} else if (process.env.EXCLUSIONS_MODE === 'collision-protection') {
  const shared = tracked('shared')
  test.concurrent('collision', preventFailureSuppression(shared))
  test.concurrent('collision', shared)
} else if (process.env.EXCLUSIONS_MODE === 'concurrent') {
  const excludedCases = test.concurrent.each([1, 2])
  excludedCases('excluded %s', noAutoRetry(tracked('excluded')))
  test.concurrent('control', tracked('control'))
} else if (process.env.EXCLUSIONS_MODE === 'native-condition') {
  let executions = 0
  const retry = { count: 2, condition: () => true }
  test('native conditional retries', { retry }, noAutoRetry(tracked('native retries', () => {
    if (++executions === 1) fail()
  })))
} else if (process.env.EXCLUSIONS_MODE === 'explicit') {
  let executions = 0
  test('native retries', { retry: 2 }, noAutoRetry(tracked('native retries', () => { if (++executions === 1) fail() })))
} else if (process.env.EXCLUSIONS_MODE === 'atr') {
  test('excluded', noAutoRetry(tracked('excluded')))
  test('control', tracked('control'))
  let executions = 0
  test('protected retry', preventFailureSuppression(tracked('protected retry', () => {
    if (++executions === 1) fail()
  })))
} else {
  test('excluded', noAutoRetry(tracked('excluded', () => {})))
  test('control', tracked('control', () => {}))
}
