'use strict'
const requirePackageJson = require('../src/require-package-json')
const packageJson = require('../../../package.json')
describe('requirePackageJson', () => {
  it('should read absolute path', () => {
    const { version } = requirePackageJson(process.cwd(), module)
    expect(version).not.to.be.null
    expect(version).not.to.be.undefined
    expect(version).to.be.equals(packageJson.version)
  })

  it('should read module.paths when path is relative', () => {
    const { version } = requirePackageJson('../../../', module)
    expect(version).not.to.be.null
    expect(version).not.to.be.undefined
    expect(version).to.be.equals(packageJson.version)
  })
})
