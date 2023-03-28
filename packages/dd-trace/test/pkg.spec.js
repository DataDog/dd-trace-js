'use strict'

require('./setup/tap')

const os = require('os')
const { execSync } = require('child_process')
const proxyquire = require('proxyquire').noPreserveCache()

describe('pkg', () => {
  let pkg

  if (os.platform() !== 'win32') {
    describe('in pre-require', () => {
      it('should load the package.json correctly', () => {
        const pkg = JSON.parse(execSync(`node --require ./pkg-loader.js -e ""`, {
          cwd: __dirname
        }).toString())
        expect(pkg.name).to.equal('dd-trace')
      })
    })
  }

  beforeEach(() => {
    pkg = require('../src/pkg')
  })

  it('should load the service name from the main module', () => {
    expect(pkg.name).to.equal('dd-trace')
  })

  it('should load the version number from the main module', () => {
    expect(pkg.version).to.match(/^\d+.\d+.\d+/)
  })
})

describe('load', () => {
  it('should not break if path.parse returns undefined', () => {
    const pathStub = { }
    pathStub.parse = function () {
      return undefined
    }
    proxyquire('../src/pkg', { 'path': pathStub })
  })
})
