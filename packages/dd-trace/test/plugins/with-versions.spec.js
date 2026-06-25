'use strict'

const assert = require('node:assert/strict')

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
})
