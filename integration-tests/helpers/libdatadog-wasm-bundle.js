'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { brotliCompressSync } = require('node:zlib')

const PACKAGE_NAME = '@datadog/libdatadog-wasm'
const outputs = {
  wasm: 'main WASM',
  remoteConfig: 'remote config WASM',
}

function createFixture () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-libdatadog-wasm-bundle-'))
  const packageRoot = path.join(directory, 'node_modules', PACKAGE_NAME)
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: PACKAGE_NAME,
    version: '0.22.0',
    main: 'index.js',
    exports: {
      '.': './index.js',
      './remote-config': './remote-config.js',
    },
  }))

  const assets = []
  writeModule(packageRoot, 'index.js', 'main_bg.wasm.br', outputs.wasm, assets)
  writeModule(packageRoot, 'remote-config.js', 'remote_config_bg.wasm.br', outputs.remoteConfig, assets)

  const entry = path.join(directory, 'entry.js')
  fs.writeFileSync(entry, `
module.exports = {
  wasm: require('${PACKAGE_NAME}'),
  remoteConfig: require('${PACKAGE_NAME}/remote-config')
}
`)
  const externalEntry = path.join(directory, 'external.js')
  fs.writeFileSync(externalEntry, `module.exports = require('${PACKAGE_NAME}')\n`)

  return { assets, directory, entry, externalEntry, packageRoot }
}

/**
 * @param {string} packageRoot
 * @param {string} moduleName
 * @param {string} assetName
 * @param {string} value
 * @param {string[]} assets
 */
function writeModule (packageRoot, moduleName, assetName, value, assets) {
  const asset = path.join(packageRoot, assetName)
  fs.writeFileSync(asset, brotliCompressSync(Buffer.from(value)))
  assets.push(asset)
  fs.writeFileSync(path.join(packageRoot, moduleName), `
'use strict'
const compressedWasm = /* @datadog/wasm-asset */ require('node:fs').readFileSync(\`\${__dirname}/${assetName}\`)
module.exports = require('node:zlib').brotliDecompressSync(compressedWasm).toString()
`)
}

/**
 * @param {(entry: string, output: string, external?: boolean) => Promise<void>} bundle
 */
async function testLibdatadogWasmBundle (bundle) {
  await testInlineBundle(bundle)
  await testMissingAsset(bundle)
  await testExternalBundle(bundle)
}

/**
 * @param {(entry: string, output: string, external?: boolean) => Promise<void>} bundle
 */
async function testInlineBundle (bundle) {
  const fixture = createFixture()
  const output = path.join(fixture.directory, 'bundle.cjs')
  try {
    await bundle(fixture.entry, output)
    fs.rmSync(fixture.packageRoot, { recursive: true })
    const source = fs.readFileSync(output, 'utf8')
    assert.doesNotMatch(source, /@datadog\/wasm-asset|\.wasm\.br/)
    assert.match(source, /base64/)
    assert.deepStrictEqual(require(output), outputs)
  } finally {
    fs.rmSync(fixture.directory, { force: true, recursive: true })
  }
}

/**
 * @param {(entry: string, output: string, external?: boolean) => Promise<void>} bundle
 */
async function testMissingAsset (bundle) {
  const fixture = createFixture()
  const output = path.join(fixture.directory, 'bundle.cjs')
  try {
    fs.rmSync(fixture.assets[0])
    await assert.rejects(bundle(fixture.entry, output), /main_bg\.wasm\.br/)
  } finally {
    fs.rmSync(fixture.directory, { force: true, recursive: true })
  }
}

/**
 * @param {(entry: string, output: string, external?: boolean) => Promise<void>} bundle
 */
async function testExternalBundle (bundle) {
  const fixture = createFixture()
  const output = path.join(fixture.directory, 'bundle.cjs')
  try {
    for (const asset of fixture.assets) {
      fs.rmSync(asset)
    }
    await bundle(fixture.externalEntry, output, true)
    const source = fs.readFileSync(output, 'utf8')
    assert.match(source, /@datadog\/libdatadog-wasm/)
    assert.doesNotMatch(source, /base64/)
  } finally {
    fs.rmSync(fixture.directory, { force: true, recursive: true })
  }
}

module.exports = testLibdatadogWasmBundle
