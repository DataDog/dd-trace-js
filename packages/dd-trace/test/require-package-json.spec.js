'use strict'

const t = require('tap')
require('./setup/core')

const requirePackageJson = require('../src/require-package-json')
const packageJson = require('../../../package.json')
t.test('requirePackageJson', t => {
  t.test('should read absolute path', t => {
    const { version } = requirePackageJson(process.cwd(), module)
    expect(version).not.to.be.null
    expect(version).not.to.be.undefined
    expect(version).to.be.equals(packageJson.version)
    t.end()
  })

  t.test('should read module.paths when path is relative', t => {
    const { version } = requirePackageJson('../../../', module)
    expect(version).not.to.be.null
    expect(version).not.to.be.undefined
    expect(version).to.be.equals(packageJson.version)
    t.end()
  })
  t.end()
})
