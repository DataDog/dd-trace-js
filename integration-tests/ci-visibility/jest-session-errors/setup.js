'use strict'

if (process.env.JEST_SETUP_ERROR_MODE.startsWith('shared')) {
  throw new TypeError('Test setup unavailable')
}

if (process.env.JEST_SETUP_ERROR_MODE === 'distinct') {
  throw new Error(`Cannot initialize ${expect.getState().testPath.split(/[\\/]/).pop()}`)
}

if (process.env.JEST_SETUP_ERROR_MODE === 'hook') {
  beforeAll(() => { throw new Error('Test hook failed') })
}
