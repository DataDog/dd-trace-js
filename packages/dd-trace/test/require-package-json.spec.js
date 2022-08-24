'use strict'
const { requirePackageVersion } = require('../src/require-package-json')
const packageJson = require('../../../package.json')
describe('requirePackageJson', () => {
  it('should read absolute path', () => {
    const version = requirePackageVersion(process.cwd(), module)
    expect(version).not.to.be.null
    expect(version).not.to.be.undefined
    expect(version).to.be.equals(packageJson.version)
  })

  it('should read module.paths when path is relative', () => {
    const version = requirePackageVersion('../../../', module)
    expect(version).not.to.be.null
    expect(version).not.to.be.undefined
    expect(version).to.be.equals(packageJson.version)
  })
})
