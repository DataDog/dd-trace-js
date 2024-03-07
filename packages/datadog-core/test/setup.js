'use strict'

require('tap')
const { describe, it, before, beforeEach, after, afterEach } = require('@tapjs/mocha-globals')
globalThis.describe = describe
globalThis.it = it
globalThis.before = before
globalThis.after = after
globalThis.beforeEach = beforeEach
globalThis.afterEach = afterEach

const chai = require('chai')
const sinonChai = require('sinon-chai')

chai.use(sinonChai)
