'use strict'

const loggerName = process.env.TEST_LOGGER

describe(`${loggerName} transitive module lifecycle`, () => {
  it('reloads transitive modules after jest.resetModules()', () => {
    const firstState = require(loggerName).state
    firstState.mutated = true

    jest.resetModules()

    const reloadedState = require(loggerName).state
    expect(reloadedState).not.toBe(firstState)
    expect(reloadedState.mutated).toBeUndefined()
  })

  it('uses separate transitive modules inside jest.isolateModules()', () => {
    const outerState = require(loggerName).state
    let isolatedState

    jest.isolateModules(() => {
      isolatedState = require(loggerName).state
      isolatedState.mutated = true
    })

    expect(isolatedState).not.toBe(outerState)
    expect(outerState.mutated).toBeUndefined()
    expect(require(loggerName).state).toBe(outerState)
  })
})
