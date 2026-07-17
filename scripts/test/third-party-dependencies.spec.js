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
            "unversioned": "file:../unversioned"
          }
        }],
        "foo/nested": ["nested@3.0.0", "", {}],
        "foo/unversioned": ["unversioned", "", {}],
        "@scope/optional": ["@scope/optional@2.0.0", "", {}],
      },
    }`)

    assert.deepStrictEqual(listBunLockDependencies(lockPath), [
      { name: '@scope/optional', version: '2.0.0' },
      { name: 'foo', version: '1.0.0' },
      { name: 'nested', version: '3.0.0' },
      { name: 'unversioned', version: '' },
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

  it('handles missing manifests, incomplete locks, and duplicate package names', () => {
    const missingPath = path.join(fixtureDirectory, 'missing')
    const packagePath = writeFixture('edge-package.json', JSON.stringify({
      dependencies: {
        emptyAlias: 'npm:',
        local: 'file:../local',
        number: 1,
        unversionedAlias: 'npm:upstream',
      },
    }))
    const emptyLockPath = writeFixture('empty-bun.lock', '{"workspaces": {}, "packages": {}}')
    const lockPath = writeFixture('edge-bun.lock', JSON.stringify({
      workspaces: {
        '': {
          dependencies: {
            alternate: '2.0.0',
            duplicate: '1.0.0',
            foo: '1.0.0',
            invalid: '1.0.0',
            missing: '1.0.0',
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
        invalid: [42, '', undefined],
        nested: ['nested@2.0.0', '', {}],
      },
    }))
    const optionalOnlyLockPath = writeFixture('optional-only-bun.lock', JSON.stringify({
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
