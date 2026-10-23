'use strict'

const assert = require('assert').strict

// eslint-disable-next-line sonarjs/stable-tests -- exercise the native retry ceiling
jest.retryTimes(Number(process.env.JEST_NATIVE_RETRIES))

it('respects native retries', () => assert.fail('native retry failure'))
