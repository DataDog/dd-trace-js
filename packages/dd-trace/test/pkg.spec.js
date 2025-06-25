'use strict'

const t = require('tap')
require('./setup/core')

const os = require('os')
const { execSync } = require('child_process')
const proxyquire = require('proxyquire').noPreserveCache()

t.test('pkg', t => {
  let pkg

  if (os.platform() !== 'win32') {
    t.test('in pre-require', t => {
      t.test('should load the package.json correctly', t => {
        const pkg = JSON.parse(execSync('node --require ./pkg-loader.js -e ""', {
          cwd: __dirname
        }).toString())
        expect(pkg.name).to.equal('dd-trace')
        t.end()
      })
      t.end()
    })
  }

  t.beforeEach(() => {
    pkg = require('../src/pkg')
  })

  t.test('should load the service name from the main module', t => {
    expect(pkg.name).to.equal('dd-trace')
    t.end()
  })

  t.test('should load the version number from the main module', t => {
    expect(pkg.version).to.match(/^\d+.\d+.\d+/)
    t.end()
  })
  t.end()
})

t.test('load', t => {
  t.test('should not break if path.parse returns undefined', t => {
    const pathStub = { }
    pathStub.parse = function () {
      return undefined
    }
    proxyquire('../src/pkg', { path: pathStub })
    t.end()
  })
  t.end()
})
