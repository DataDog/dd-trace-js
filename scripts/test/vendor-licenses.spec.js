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

  it('includes the license file of a transitive package outside the entry list', async () => {
    const text = await bundle('MIT', 'Entry license\n', { license: 'ISC', licenseText: 'Dependency license\n' })
    assert.strictEqual(text, 'crypto-randomuuid\n\nEntry license\n\n' +
      '-'.repeat(78) + '\n\ntransitive-fixture\n\nDependency license\n')
  })

  it('preserves a transitive license declaration when the license file is absent', async () => {
    const text = await bundle('MIT', undefined, { license: 'ISC' })
    assert.strictEqual(text, 'crypto-randomuuid\n\nMIT\n\n' +
      '-'.repeat(78) + '\n\ntransitive-fixture\n\nISC\n')
  })

  it('sorts bundled packages by name independently of their import order', async () => {
    const text = await bundle('MIT', 'Entry license\n', {
      name: 'aaa-fixture', license: 'ISC', licenseText: 'Dependency license\n',
    })
    assert.strictEqual(text, 'aaa-fixture\n\nDependency license\n\n' +
      '-'.repeat(78) + '\n\ncrypto-randomuuid\n\nEntry license\n')
  })

  it('rejects a transitive package without a license declaration or file', async () => {
    await assert.rejects(bundle('MIT', undefined, {}), /No license text resolved for bundled package 'transitive-fixture'/)
  })

  it('rejects a transitive license reference whose file is missing', async () => {
    await assert.rejects(bundle('MIT', undefined, { license: 'SEE LICENSE IN missing.txt' }),
      /No license text resolved for bundled package 'transitive-fixture'/)
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
 * @param {{ name?: string, license?: string, licenseText?: string }} [dependency]
 */
async function bundle (license, licenseText, dependency) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-vendor-license-'))
  let compiler
  try {
    const dependencyName = dependency?.name ?? 'transitive-fixture'
    writePackage(cwd, 'crypto-randomuuid', license, licenseText,
      dependency ? `module.exports = require('${dependencyName}')\n` : 'module.exports = 42\n')
    if (dependency) {
      writePackage(cwd, dependencyName, dependency.license, dependency.licenseText)
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

/**
 * @param {string} cwd
 * @param {string} name
 * @param {string} [license]
 * @param {string} [licenseText]
 * @param {string} [source]
 */
function writePackage (cwd, name, license, licenseText, source = 'module.exports = 42\n') {
  const directory = path.join(cwd, 'node_modules', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name, version: '1.0.0', main: 'index.js', license,
  }))
  fs.writeFileSync(path.join(directory, 'index.js'), source)
  if (licenseText !== undefined) {
    fs.writeFileSync(path.join(directory, 'LICENSE'), licenseText)
  }
}
