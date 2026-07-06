'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { afterEach, beforeEach, describe, it } = require('mocha')

const expressPlugin = require('../../../datadog-plugin-express/src')
const { withVersions } = require('../setup/mocha')

describe('withVersions', () => {
  let packageNames

  beforeEach(() => {
    // PACKAGE_NAMES short-circuits the call before the guard runs; clear it so the assertions are deterministic
    // regardless of the surrounding CI matrix env.
    packageNames = process.env.PACKAGE_NAMES
    delete process.env.PACKAGE_NAMES
  })

  afterEach(() => {
    if (packageNames === undefined) {
      delete process.env.PACKAGE_NAMES
    } else {
      process.env.PACKAGE_NAMES = packageNames
    }
  })

  it('throws when no instrumentation declares the module', () => {
    assert.throws(
      () => withVersions('express', 'not-a-real-module', () => {}),
      { message: /no instrumentation declares the module "not-a-real-module"/ }
    )
  })

  it('throws when the plugin export is passed instead of the integration name', () => {
    // The export's `.name` is the class name ('ExpressPlugin'), not 'express', so nothing matches the module
    // and the suite would otherwise be silently skipped.
    assert.throws(
      () => withVersions(expressPlugin, 'loopback', () => {}),
      { message: /no instrumentation declares the module "loopback"/ }
    )
  })

  // A Node-version gate written as `NODE_MAJOR >= 25 && '>=1.3.0'` collapses to `false` on older Node; the old
  // `!range` guard treated that as "run every version", so the intended restriction vanished without a trace.
  for (const badRange of [false, '', null, undefined]) {
    it(`throws when the range is ${inspect(badRange)} instead of a version string`, () => {
      assert.throws(
        () => withVersions('express', 'express', badRange, () => {}),
        { name: 'TypeError', message: /version range must be a non-empty string/ }
      )
    })
  }

  // Both legitimate shapes reach the module resolver, so they fail with the module error rather than the range
  // TypeError — proving range validation let them through: the omitted-range function form leaves range undefined,
  // and an explicit '*' is a valid range.
  for (const validCall of [
    () => withVersions('express', 'not-a-real-module', () => {}),
    () => withVersions('express', 'not-a-real-module', '*', () => {}),
  ]) {
    it('lets a valid range through to module resolution', () => {
      assert.throws(validCall, { message: /no instrumentation declares the module "not-a-real-module"/ })
    })
  }
})
