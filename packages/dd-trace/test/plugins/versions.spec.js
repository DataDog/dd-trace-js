'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const { coerce, major } = require('semver')

const { getVersionList, resolvePluginVersions, brokenVersionReason } = require('./versions')

const latests = require('./versions/package.json').dependencies

const keys = (name, versions, nonConsecutive) =>
  getVersionList(name, versions, nonConsecutive).map(({ versionKey }) => versionKey)

const latestMajorKey = name => String(major(coerce(latests[name])))

describe('getVersionList', () => {
  it('collapses the wildcard to the latest major', () => {
    assert.deepEqual(keys('mongodb', ['*']), [latestMajorKey('mongodb')])
  })

  it('collapses equivalent exact-version notations to a single key', () => {
    assert.deepEqual(keys('mongodb', ['1.2.3', '=1.2.3', 'v1.2.3']), ['1.2.3'])
  })

  it('pins the floor and the major for a single-major range', () => {
    // `<3` caps the range to major 2, so only the pinned floor and the latest of major 2 are keys.
    assert.deepEqual(keys('mongodb', ['>=2 <3']), ['2.0.0', '2'])
  })

  it('covers the floor major and every major up to the range top', () => {
    // `<5` caps the top at major 4; the floor (2.0.0) is pinned and majors 2-4 each resolve to their latest.
    assert.deepEqual(keys('mongodb', ['>=2 <5']), ['2.0.0', '2', '3', '4'])
  })

  it('covers every major from the floor to the capped top', () => {
    // `<6` caps the top at major 5; the floor major's latest (1) is covered too, not only the newest of the range.
    assert.deepEqual(keys('mongodb', ['>=1 <6']), ['1.0.0', '1', '2', '3', '4', '5'])
  })

  it('keeps the declared range for a top major the range caps mid-way', () => {
    // `<=3.0.0` stops inside major 3, so a bare `3` (which resolves to the major's latest) would overshoot the
    // ceiling; the declared range is kept instead so it resolves to the newest version `<=3.0.0`.
    assert.deepEqual(keys('mongodb', ['>=2.1 <=3.0.0']), ['2.1.0', '2', '>=2.1 <=3.0.0'])
  })

  it('keeps a sub-major range as its own key', () => {
    // `>=4.0.0 <4.3.0` never spans major 4 in full, so there is no safe bare major; the floor and the range cover it.
    assert.deepEqual(keys('mongodb', ['>=4.0.0 <4.3.0']), ['4.0.0', '>=4.0.0 <4.3.0'])
  })

  it('de-duplicates a shared floor across multiple ranges', () => {
    assert.deepEqual(keys('mongodb', ['>=2 <3', '^2.0.0']), ['2.0.0', '2'])
  })

  it('consolidates the floor with the top major when the floor is the pinned latest', () => {
    // `>=<pinned latest>` floors at the newest version, so the bare top-major key resolves to that same version and is
    // dropped; the pinned package.json is what proves the two keys identical.
    assert.deepEqual(keys('mongodb', [`>=${latests.mongodb}`]), [latests.mongodb])
  })

  it('adds the floor, the floor major and the top major for non-consecutive packages', () => {
    // The middle majors may be unpublished, but the floor major (1) and the top major (5) both exist and are tested.
    assert.deepEqual(keys('mongodb', ['>=1 <6'], new Set(['mongodb'])), ['1.0.0', '1', '5'])
  })

  it('treats the built-in non-consecutive packages as floor + floor major + top major', () => {
    // graphql jumps from 0.x to 14.x; 1.x–13.x are skipped, but the latest 0.x and the newest major are still tested.
    assert.deepEqual(keys('graphql', ['>=0.10']), ['0.10.0', '0', latestMajorKey('graphql')])
  })

  it('throws on an unparseable range', () => {
    assert.throws(() => getVersionList('mongodb', ['not-a-version']), /Invalid version range/)
  })

  it('throws on an empty entry', () => {
    assert.throws(() => getVersionList('mongodb', ['', '>=2 <3']), /Empty version entry/)
  })
})

describe('resolvePluginVersions', () => {
  const versionKeys = result => result.versionList.map(({ versionKey }) => versionKey)

  it('expands the declared versions and points the unversioned folder at the newest in-scope key', () => {
    const result = resolvePluginVersions({ name: 'mongodb', declaredVersions: ['>=2 <5'], env: {} })

    assert.deepEqual(versionKeys(result), ['2.0.0', '2', '3', '4'])
    assert.equal(result.unversioned, '4')
  })

  it('includes declarations at the Node.js range boundary', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=2 <5'],
      nodeRange: '>=22',
      nodeVersion: '22.0.0',
      env: {},
    })

    assert.deepEqual(versionKeys(result), ['2.0.0', '2', '3', '4'])
    assert.equal(result.unversioned, '4')
  })

  it('excludes declarations outside the Node.js range before applying package range overrides', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=2 <5'],
      nodeRange: '>=22',
      nodeVersion: '21.999.999',
      env: { PACKAGE_VERSION_RANGE: '>=3 <4' },
    })

    assert.deepEqual(result.versionList, [])
    assert.equal(result.unversioned, undefined)
  })

  it('throws on an invalid Node.js range', () => {
    assert.throws(
      () => resolvePluginVersions({
        name: 'mongodb',
        declaredVersions: ['>=2 <5'],
        nodeRange: 'not-a-version',
        nodeVersion: '22.0.0',
        env: {},
      }),
      /Invalid Node.js version range/
    )
  })

  it('filters the installed keys by RANGE and follows the filtered tail', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=1 <6'],
      env: { RANGE: '>=2.0.0 <4.0.0' },
    })

    assert.deepEqual(versionKeys(result), ['2', '3'])
    assert.equal(result.unversioned, '3')
  })

  it('replaces the declared versions with PACKAGE_VERSION_RANGE when the module is honoured', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=2 <5'],
      env: { PACKAGE_VERSION_RANGE: '>=3 <4' },
    })

    assert.deepEqual(versionKeys(result), ['3.0.0', '3'])
    assert.equal(result.unversioned, '>=3 <4')
  })

  it('ignores PACKAGE_VERSION_RANGE for a sibling external that must not be sharded', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=2 <5'],
      honourEnvRange: false,
      env: { PACKAGE_VERSION_RANGE: '>=3 <4' },
    })

    assert.deepEqual(versionKeys(result), ['2.0.0', '2', '3', '4'])
    assert.equal(result.unversioned, '4')
  })

  it('keeps the unversioned folder on the raw shard while RANGE narrows the installed keys', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=1 <6'],
      env: { PACKAGE_VERSION_RANGE: '>=2 <5', RANGE: '>=3.0.0 <4.0.0' },
    })

    assert.deepEqual(versionKeys(result), ['3'])
    assert.equal(result.unversioned, '>=2 <5')
  })

  it('reports nothing in scope when no version is declared', () => {
    const result = resolvePluginVersions({ name: 'mongodb', declaredVersions: [], env: {} })

    assert.deepEqual(result.versionList, [])
    assert.equal(result.unversioned, undefined)
  })

  it('reports nothing in scope when RANGE excludes every declared key', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=2 <3'],
      env: { RANGE: '>=9.0.0 <10.0.0' },
    })

    assert.deepEqual(result.versionList, [])
    assert.equal(result.unversioned, undefined)
  })
})

describe('brokenVersionReason', () => {
  const broken = { ai: [{ range: '>=4.1.0 <5.0.0', reason: 'no cassette' }] }

  it('returns the reason for a version inside a broken range', () => {
    assert.equal(brokenVersionReason('ai', '4.3.19', broken), 'no cassette')
  })

  it('returns undefined outside every broken range and for unlisted modules', () => {
    assert.equal(brokenVersionReason('ai', '4.0.0', broken), undefined)
    assert.equal(brokenVersionReason('mongodb', '4.3.19', broken), undefined)
  })
})
