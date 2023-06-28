'use strict'

global.tests = []
global.beforeEachHooks = []
global.afterEachHooks = []

function describe (description, cb) {
  cb()
}

function test (description, fn) {
  global.tests.push({ description, fn })
}

function beforeEach (fn) {
  global.beforeEachHooks.push(fn)
}

function afterEach (fn) {
  global.afterEachHooks.push(fn)
}

global.describe = describe
global.test = test
global.beforeEach = beforeEach
global.afterEach = afterEach
global.assert = {
  equal: (a, b) => {
    if (a !== b) {
      throw new Error(`${a} is not equal to ${b}`)
    }
  }
}
