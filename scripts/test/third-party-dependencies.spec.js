'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const {
  collectAliasMap,
  listBunLockDependencies,
  readVendoredDependencyNames,
} = require('../third-party-dependencies')

describe('third-party dependency locks', () => {
  let fixtureDirectory

  beforeEach(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-third-party-dependencies-'))
  })

  afterEach(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('walks regular, optional, nested, and scoped Bun dependencies', () => {
    const lockPath = writeFixture('bun.lock', `{
      "lockfileVersion": 1,
      "workspaces": {
        "": {
          "dependencies": {
            "foo": "1.0.0"
          },
          "optionalDependencies": {
            "@scope/optional": "2.0.0"
          }
        }
      },
      "packages": {
        "foo": ["foo@1.0.0", "", {
          "dependencies": {
            "nested": "3.0.0"
          },
          "optionalDependencies": {
            "local": "file:../local"
          }
        }],
        "foo/nested": ["nested@3.0.0", "", {}],
        "foo/local": ["local@file:../local", "", {}],
        "@scope/optional": ["@scope/optional@2.0.0", "", {}],
      },
    }`)

    assert.deepStrictEqual(listBunLockDependencies(lockPath), [
      { name: '@scope/optional', version: '2.0.0' },
      { name: 'foo', version: '1.0.0' },
      { name: 'local', version: 'file:../local' },
      { name: 'nested', version: '3.0.0' },
    ])
  })

  it('walks the peers of a production dependency and skips uninstalled optional peers', () => {
    // `bun install --production` resolves a production package's peers, so they reach the shipped OCI package and need
    // attribution even when the range pinning them is declared under `devDependencies` (recorded separately in the
    // lock and never read by this walk). An optional peer nobody installed has no `packages` entry and drops out.
    const lockPath = writeFixture('bun.lock', `{
      "lockfileVersion": 1,
      "workspaces": {
        "": {
          "dependencies": {
            "provider": "1.0.0"
          },
          "devDependencies": {
            "dev-only": "9.9.9"
          }
        }
      },
      "packages": {
        "provider": ["provider@1.0.0", "", {
          "peerDependencies": {
            "peer-sdk": ">=1.15.1",
            "absent-optional-peer": "^1.0.0"
          },
          "optionalPeers": ["absent-optional-peer"]
        }],
        "peer-sdk": ["peer-sdk@1.22.0", "", {
          "dependencies": {
            "peer-core": "1.11.0"
          }
        }],
        "peer-core": ["peer-core@1.11.0", "", {}],
        "dev-only": ["dev-only@9.9.9", "", {}],
      },
    }`)

    assert.deepStrictEqual(listBunLockDependencies(lockPath), [
      { name: 'peer-core', version: '1.11.0' },
      { name: 'peer-sdk', version: '1.22.0' },
      { name: 'provider', version: '1.0.0' },
    ])
  })

  it('reads aliases and vendored names', () => {
    const rootPackagePath = writeFixture('package.json', JSON.stringify({
      dependencies: {
        alias: 'npm:upstream@1.0.0',
      },
    }))
    const vendorPackagePath = writeFixture('vendor-package.json', JSON.stringify({
      optionalDependencies: {
        '@scope/alias': 'npm:@scope/upstream@2.0.0',
      },
    }))
    const vendoredPath = writeFixture('vendored.csv', [
      '"vendored-one","https://example.com","[\'MIT\']","[\'One\']"',
      '"vendored-two","https://example.com","[\'ISC\']","[\'Two\']"',
      '',
    ].join('\n'))

    assert.deepStrictEqual(collectAliasMap([rootPackagePath, vendorPackagePath]), new Map([
      ['alias', 'upstream'],
      ['@scope/alias', '@scope/upstream'],
    ]))
    assert.deepStrictEqual(readVendoredDependencyNames(vendoredPath), ['vendored-one', 'vendored-two'])
  })

  it('handles missing manifests, empty locks, and duplicate package names', () => {
    const missingPath = path.join(fixtureDirectory, 'missing')
    const packagePath = writeFixture('edge-package.json', JSON.stringify({
      dependencies: {
        emptyAlias: 'npm:',
        local: 'file:../local',
        number: 1,
        unversionedAlias: 'npm:upstream',
      },
    }))
    const emptyLockPath = writeFixture(
      'empty-bun.lock',
      '{"lockfileVersion": 1, "workspaces": {"": {}}, "packages": {}}'
    )
    const lockPath = writeFixture('edge-bun.lock', JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        '': {
          dependencies: {
            alternate: '2.0.0',
            duplicate: '1.0.0',
            foo: '1.0.0',
          },
        },
      },
      packages: {
        alternate: ['foo@2.0.0', '', {}],
        duplicate: ['foo@1.0.0', '', {}],
        foo: ['foo@1.0.0', '', {
          dependencies: {
            nested: '2.0.0',
          },
          optionalDependencies: {
            nested: '2.0.0',
          },
        }],
        nested: ['nested@2.0.0', '', {}],
      },
    }))
    const optionalOnlyLockPath = writeFixture('optional-only-bun.lock', JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        '': {
          optionalDependencies: {
            optional: '1.0.0',
          },
        },
      },
      packages: {
        optional: ['optional@1.0.0', '', {}],
      },
    }))
    assert.deepStrictEqual(collectAliasMap([missingPath, packagePath]), new Map([
      ['unversionedAlias', 'upstream'],
    ]))
    assert.deepStrictEqual(listBunLockDependencies(emptyLockPath), [])
    assert.deepStrictEqual(listBunLockDependencies(lockPath), [
      { name: 'foo', version: '1.0.0' },
      { name: 'foo', version: '2.0.0' },
      { name: 'nested', version: '2.0.0' },
    ])
    assert.deepStrictEqual(listBunLockDependencies(optionalOnlyLockPath), [
      { name: 'optional', version: '1.0.0' },
    ])
    assert.deepStrictEqual(readVendoredDependencyNames(missingPath), [])
  })

  it('resolves hoisted ancestors and traverses workspaces without attributing links', () => {
    const lockPath = writeFixture('hoisted-bun.lock', JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        '': { dependencies: { parent: '1.0.0', shared: '9.0.0', local: 'workspace:packages/local' } },
        'packages/local': { dependencies: { transitive: '1.0.0', linked: 'link:../linked' } },
      },
      packages: {
        parent: ['parent@1.0.0', '', { dependencies: { child: '1.0.0' } }],
        'parent/child': ['child@1.0.0', '', { dependencies: { shared: '2.0.0' } }],
        'parent/shared': ['shared@2.0.0', '', {}],
        shared: ['shared@9.0.0', '', {}],
        local: ['local@workspace:packages/local'],
        transitive: ['transitive@1.0.0', '', {}],
        linked: ['linked@link:../linked'],
      },
    }))

    assert.deepStrictEqual(listBunLockDependencies(lockPath), [
      { name: 'child', version: '1.0.0' },
      { name: 'parent', version: '1.0.0' },
      { name: 'shared', version: '2.0.0' },
      { name: 'shared', version: '9.0.0' },
      { name: 'transitive', version: '1.0.0' },
    ])
  })

  it('accepts the current lock version and fails closed on other or incomplete locks', () => {
    const empty = { workspaces: { '': {} }, packages: {} }
    const currentLockPath = writeFixture('version-1.lock', JSON.stringify({ lockfileVersion: 1, ...empty }))
    assert.deepStrictEqual(listBunLockDependencies(currentLockPath), [])

    for (const lockfileVersion of [0, 2, -1, 1.5, '1', undefined]) {
      const lockPath = writeFixture(`version-${lockfileVersion}.lock`, JSON.stringify({
        lockfileVersion,
        ...empty,
      }))
      assert.throws(() => listBunLockDependencies(lockPath), /Unsupported lockfile version/)
    }

    const missingPath = writeFixture('missing.lock', JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { dependencies: { missing: '1.0.0' } } },
      packages: {},
    }))
    assert.throws(() => listBunLockDependencies(missingPath), /Missing .* entry for missing/)

    const invalidPath = writeFixture('invalid.lock', JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { dependencies: { invalid: '1.0.0' } } },
      packages: { invalid: [42, '', {}] },
    }))
    assert.throws(() => listBunLockDependencies(invalidPath), /Invalid .* entry for invalid/)

    for (const resolution of ['invalid', 'invalid@']) {
      const resolutionPath = writeFixture(`resolution-${resolution.length}.lock`, JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { dependencies: { invalid: '1.0.0' } } },
        packages: { invalid: [resolution, '', {}] },
      }))
      assert.throws(() => listBunLockDependencies(resolutionPath), /Invalid Bun package resolution/)
    }

    const workspacePath = writeFixture('workspace.lock', JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { dependencies: { local: 'workspace:packages/local' } } },
      packages: { local: ['local@workspace:packages/local'] },
    }))
    assert.throws(() => listBunLockDependencies(workspacePath), /Missing .* workspace for local/)
  })

  it('rejects unparseable and structurally invalid locks', () => {
    const cases = [
      ['broken.lock', '{ "lockfileVersion": 1, ', /Cannot parse .* at offset/],
      ['array.lock', '[]', /does not contain an object/],
      ['packages.lock', '{"lockfileVersion":1,"workspaces":{"":{}},"packages":[]}', /package metadata/],
      ['workspaces.lock', '{"lockfileVersion":1,"packages":{}}', /workspace metadata/],
      ['root.lock', '{"lockfileVersion":1,"workspaces":{"other":{}},"packages":{}}', /root workspace/],
    ]
    for (const [filename, content, expected] of cases) {
      const lockPath = writeFixture(filename, content)
      assert.throws(() => listBunLockDependencies(lockPath), expected)
    }
  })

  /**
   * @param {string} filename
   * @param {string} content
   */
  function writeFixture (filename, content) {
    const fixturePath = path.join(fixtureDirectory, filename)
    fs.writeFileSync(fixturePath, content)
    return fixturePath
  }
})
