'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('tap').mocha
const os = require('node:os')
const { execSync } = require('node:child_process')
const proxyquire = require('proxyquire').noPreserveCache()

require('./setup/core')

describe('pkg', () => {
  let pkg

  if (os.platform() !== 'win32') {
    describe('in pre-require', () => {
      it('should load the package.json correctly', () => {
        const pkg = JSON.parse(execSync('node --require ./pkg-loader.js -e ""', {
          cwd: __dirname
        }).toString())
        assert.strictEqual(pkg.name, 'dd-trace')
      })
    })
  }

  beforeEach(() => {
    pkg = require('../src/pkg')
  })

  it('should load the service name from the main module', () => {
    assert.strictEqual(pkg.name, 'dd-trace')
  })

  it('should load the version number from the main module', () => {
    assert.match(pkg.version, /^\d+.\d+.\d+/)
  })
})

describe('load', () => {
  it('should not break if path.parse returns undefined', () => {
    const pathStub = { }
    pathStub.parse = function () {
      return undefined
    }
    proxyquire('../src/pkg', { path: pathStub })
  })
})
