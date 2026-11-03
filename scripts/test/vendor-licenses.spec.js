'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const { rspack } = require('../../vendor/node_modules/@rspack/core')
const config = require('../../vendor/rspack.config')

describe('vendor licenses', () => {
  for (const license of ['MIT', 'Apache-2.0', 'LicenseRef-unknown']) {
    it(`preserves '${license}' when the package has no license file`, async () => {
      const text = await bundle(license)
      assert.doesNotMatch(text, /Permission is hereby granted|THE SOFTWARE IS PROVIDED/)
      assert.strictEqual(text, `crypto-randomuuid\n\n${license}\n`)
    })
  }

  it('preserves a published license file', async () => {
    const licenseText = 'Copyright Example Author\nPackage-specific license terms\n'
    const text = await bundle('MIT', licenseText)
    assert.strictEqual(text, `crypto-randomuuid\n\n${licenseText}`)
  })

  it('rejects a package without a license declaration or file', async () => {
    await assert.rejects(bundle(), /No license text resolved for bundled package/)
  })

  it('rejects a license reference whose file is missing', async () => {
    await assert.rejects(bundle('SEE LICENSE IN missing.txt'), /No license text resolved for bundled package/)
  })
})

/**
 * @param {string} [license]
 * @param {string} [licenseText]
 */
async function bundle (license, licenseText) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-vendor-license-'))
  const packageDir = path.join(cwd, 'node_modules/crypto-randomuuid')
  let compiler
  try {
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'crypto-randomuuid', version: '1.0.0', main: 'index.js', license,
    }))
    fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = 42\n')
    if (licenseText !== undefined) {
      fs.writeFileSync(path.join(packageDir, 'LICENSE'), licenseText)
    }
    fs.writeFileSync(path.join(cwd, 'index.js'), "module.exports = require('crypto-randomuuid')\n")
    compiler = rspack({
      ...config,
      context: cwd,
      entry: { fixture: './index.js' },
      output: { ...config.output, path: path.join(cwd, 'dist') },
      plugins: [config.plugins[0]],
    })
    const run = promisify(compiler.run.bind(compiler))
    const stats = await run()
    if (stats.hasErrors()) {
      throw new Error(stats.toString({ all: false, errors: true }))
    }
    return fs.readFileSync(path.join(cwd, 'dist/fixture/LICENSE'), 'utf8')
  } finally {
    try {
      if (compiler) {
        const close = promisify(compiler.close.bind(compiler))
        await close()
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }
}
