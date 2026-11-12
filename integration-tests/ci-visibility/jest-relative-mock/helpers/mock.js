'use strict'

// eslint-disable-next-line sonarjs/stable-tests -- Deliberately exercise native retry attribution from a helper.
jest.retryTimes(2)
jest.mock('./dependency.js', () => 'mocked')

module.exports = require('./dependency.js')
