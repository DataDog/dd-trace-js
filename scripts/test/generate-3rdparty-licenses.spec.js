'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(__dirname, '..', '..')
const generatorPath = path.join(repoRoot, 'scripts', 'generate-3rdparty-licenses.js')
const concurrencyHelperPath = path.join(repoRoot, 'scripts', 'helpers', 'concurrency.js')
const dependencyHelperPath = path.join(repoRoot, 'scripts', 'third-party-dependencies.js')

describe('scripts/generate-3rdparty-licenses.js', () => {
  let fixtureDirectory

  beforeEach(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-license-generator-'))
    fs.mkdirSync(path.join(fixtureDirectory, '.github'))
    fs.mkdirSync(path.join(fixtureDirectory, 'scripts'))
    fs.mkdirSync(path.join(fixtureDirectory, 'scripts', 'helpers'))
    fs.mkdirSync(path.join(fixtureDirectory, 'vendor'))
    fs.copyFileSync(generatorPath, path.join(fixtureDirectory, 'scripts', 'generate-3rdparty-licenses.js'))
    fs.copyFileSync(concurrencyHelperPath, path.join(fixtureDirectory, 'scripts', 'helpers', 'concurrency.js'))
    fs.copyFileSync(dependencyHelperPath, path.join(fixtureDirectory, 'scripts', 'third-party-dependencies.js'))
    fs.writeFileSync(path.join(fixtureDirectory, 'package.json'), JSON.stringify({
      name: 'dd-fixture',
      version: '1.0.0',
      license: 'BSD-3-Clause',
      author: 'Fixture author',
      repository: 'https://github.com/DataDog/dd-fixture.git',
      dependencies: {
        foo: '2.0.0',
      },
    }))
    fs.writeFileSync(path.join(fixtureDirectory, 'bun.lock'), `{
      "lockfileVersion": 1,
      "workspaces": {
        "": {
          "dependencies": {
            "foo": "2.0.0"
          }
        }
      },
      "packages": {
        "foo": ["foo@2.0.0", "", {
          "dependencies": {
            "foo-old": "1.0.0"
          }
        }],
        "foo/foo-old": ["foo@1.0.0", "", {}],
      },
    }`)
    fs.writeFileSync(path.join(fixtureDirectory, 'vendor', 'package.json'), '{}')
    fs.writeFileSync(path.join(fixtureDirectory, 'vendor', 'bun.lock'), JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        '': {
          dependencies: {},
        },
      },
      packages: {},
    }))
    fs.writeFileSync(
      path.join(fixtureDirectory, '.github', 'vendored-dependencies.csv'),
      '"vendored","https://vendored.example","[\'ISC\']","[\'Vendored author\']"\r\n'
    )
    fs.writeFileSync(path.join(fixtureDirectory, 'LICENSE-3rdparty.csv'), [
      '"component","origin","license","copyright"',
      '"dd-fixture","https://github.com/DataDog/dd-fixture","[\'BSD-3-Clause\']","[\'Fixture author\']"',
      '"foo","https://old.example/""quoted""","[\'MIT\']","[\'Old author\']"',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(fixtureDirectory, 'registry-preload.js'), registryPreload)
  })

  afterEach(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('refreshes exact-version licenses while preserving reviewed copyright', async () => {
    const tracePath = path.join(fixtureDirectory, 'registry-trace.txt')
    await runGenerator({
      DD_TEST_LICENSE_METADATA: JSON.stringify({
        '1.0.0': {
          license: 'MIT',
          repository: 'https://old.example/repository',
          author: 'Old author',
        },
        '2.0.0': {
          license: 'Apache-2.0',
          repository: 'https://new.example/repository',
          author: 'New author',
        },
      }),
      DD_TEST_LICENSE_TRACE: tracePath,
    })

    // Split on CRLF rather than LF: the rows embedded from `.github/vendored-dependencies.csv` are CRLF, so this file
    // has to match or the result carries mixed endings and editors keep re-LF-ing it on save.
    const generated = fs.readFileSync(path.join(fixtureDirectory, 'LICENSE-3rdparty.csv'), 'utf8')
    assert.match(generated, /\r\n$/, 'generated CSV must use CRLF line endings')
    assert.doesNotMatch(generated, /(?<!\r)\n/, 'generated CSV must not contain a bare LF')
    assert.deepStrictEqual(
      generated.trim().split('\r\n'),
      [
        '"component","origin","license","copyright"',
        '"dd-fixture","https://github.com/DataDog/dd-fixture","[\'BSD-3-Clause\']","[\'Fixture author\']"',
        '"foo","https://old.example/""quoted""","[\'MIT\', \'Apache-2.0\']","[\'Old author\']"',
        '"vendored","https://vendored.example","[\'ISC\']","[\'Vendored author\']"',
      ]
    )
    assert.deepStrictEqual(fs.readFileSync(tracePath, 'utf8').trim().split('\n').sort(), [
      'https://registry.npmjs.org/foo/1.0.0',
      'https://registry.npmjs.org/foo/2.0.0',
    ])
  })

  it('appends copied-source attributions after the installed dependencies', async () => {
    fs.writeFileSync(
      path.join(fixtureDirectory, '.github', 'vendored-dependencies.csv'),
      '"aaa-copied","https://copied.example","[\'ISC\']","[\'Copied author\']"\r\n'
    )

    await runGenerator({
      DD_TEST_LICENSE_METADATA: JSON.stringify({
        '1.0.0': { license: 'MIT', repository: 'https://old.example/repository', author: 'Old author' },
        '2.0.0': { license: 'MIT', repository: 'https://old.example/repository', author: 'Old author' },
      }),
    })

    const generated = fs.readFileSync(path.join(fixtureDirectory, 'LICENSE-3rdparty.csv'), 'utf8')
    assert.deepStrictEqual(
      generated.trim().split('\r\n').map(line => line.slice(1, line.indexOf('","'))),
      ['component', 'dd-fixture', 'foo', 'aaa-copied']
    )
  })

  it('refreshes a single locked version license without replacing reviewed attribution', async () => {
    fs.writeFileSync(path.join(fixtureDirectory, 'bun.lock'), JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { dependencies: { foo: '2.0.0' } } },
      packages: { foo: ['foo@2.0.0', '', {}] },
    }))

    await runGenerator({
      DD_TEST_LICENSE_METADATA: JSON.stringify({
        '2.0.0': {
          license: 'Apache-2.0',
          repository: 'https://new.example/repository',
          author: 'New author',
        },
      }),
    })

    const generated = fs.readFileSync(path.join(fixtureDirectory, 'LICENSE-3rdparty.csv'), 'utf8')
    const fooRow = generated.split('\r\n').find(line => line.startsWith('"foo",'))
    assert.strictEqual(
      fooRow,
      '"foo","https://old.example/""quoted""","[\'Apache-2.0\']","[\'Old author\']"'
    )
  })

  it('fails when a copied-source attribution names an installed dependency', async () => {
    fs.writeFileSync(
      path.join(fixtureDirectory, '.github', 'vendored-dependencies.csv'),
      '"foo","https://copied.example","[\'ISC\']","[\'Copied author\']"\r\n'
    )

    await assert.rejects(
      runGenerator({
        DD_TEST_LICENSE_METADATA: JSON.stringify({
          '1.0.0': { license: 'MIT', repository: 'https://old.example/repository', author: 'Old author' },
          '2.0.0': { license: 'MIT', repository: 'https://old.example/repository', author: 'Old author' },
        }),
      }),
      matchesDuplicateAttribution
    )
  })

  it('fails without replacing license metadata when the registry request fails', async () => {
    const csvPath = path.join(fixtureDirectory, 'LICENSE-3rdparty.csv')
    const before = fs.readFileSync(csvPath, 'utf8')

    await assert.rejects(
      runGenerator({ DD_TEST_LICENSE_FAILURE: '1' }),
      matchesRegistryFailure
    )
    assert.strictEqual(fs.readFileSync(csvPath, 'utf8'), before)
  })

  /**
   * @param {Record<string, string | undefined>} env
   * @returns {ReturnType<typeof execFileAsync>}
   */
  function runGenerator (env) {
    const preloadPath = path.join(fixtureDirectory, 'registry-preload.js')
    return execFileAsync(process.execPath, [path.join(fixtureDirectory, 'scripts', 'generate-3rdparty-licenses.js')], {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        ...env,
        NODE_PATH: [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preloadPath}`.trim(),
      },
    })
  }
})

/**
 * @param {Error & { stderr: string }} error
 */
function matchesRegistryFailure (error) {
  assert.match(error.stderr, /registry unavailable/)
  return true
}

/**
 * @param {Error & { stderr: string }} error
 */
function matchesDuplicateAttribution (error) {
  assert.match(error.stderr, /'foo' is both a resolved dependency and a vendored-source entry/)
  return true
}

const registryPreload = String.raw`
'use strict'

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const https = require('node:https')

https.request = function request (url, options, callback) {
  const request = new EventEmitter()
  request.end = function end () {
    if (process.env.DD_TEST_LICENSE_TRACE) fs.appendFileSync(process.env.DD_TEST_LICENSE_TRACE, url + '\n')
    if (process.env.DD_TEST_LICENSE_FAILURE === '1') {
      process.nextTick(() => request.emit('error', new Error('registry unavailable')))
      return
    }

    const response = new EventEmitter()
    response.statusCode = 200
    response.headers = {}
    response.resume = function resume () {}
    callback(response)
    const emitMetadata = () => {
      const metadata = JSON.parse(process.env.DD_TEST_LICENSE_METADATA)
      const version = url.slice(url.lastIndexOf('/') + 1)
      response.emit('data', Buffer.from(JSON.stringify(metadata[version])))
      response.emit('end')
    }
    if (url.endsWith('/1.0.0')) setImmediate(emitMetadata)
    else process.nextTick(emitMetadata)
  }
  return request
}
`
