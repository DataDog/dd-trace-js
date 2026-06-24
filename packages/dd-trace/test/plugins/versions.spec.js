'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getVersionList, resolvePluginVersions } = require('./versions')

const keys = (name, versions, nonConsecutive) =>
  getVersionList(name, versions, nonConsecutive).map(({ versionKey }) => versionKey)

describe('getVersionList', () => {
  it('returns the wildcard untouched', () => {
    assert.deepEqual(keys('mongodb', ['*']), ['*'])
  })

  it('collapses equivalent exact-version notations to a single key', () => {
    assert.deepEqual(keys('mongodb', ['1.2.3', '=1.2.3', 'v1.2.3']), ['1.2.3'])
  })

  it('pins the floor and keeps the range for a single-major range', () => {
    // `<3` caps the range below any plausible pinned latest, so there is no in-between major to fill.
    assert.deepEqual(keys('mongodb', ['>=2 <3']), ['2.0.0', '>=2 <3'])
  })

  it('fills every in-between major between the floor and the range top', () => {
    // `<5` caps the top at major 4, so only major 3 sits strictly in between major 2 and major 4.
    assert.deepEqual(keys('mongodb', ['>=2 <5']), ['2.0.0', '>=3.0.0 <4.0.0', '>=2 <5'])
  })

  it('orders fills ascending and keeps the declared range last (the top major is covered by the range itself)', () => {
    // `<6` caps the top at major 5, which the `>=1 <6` range resolves to; only majors 2-4 are filled in between.
    assert.deepEqual(keys('mongodb', ['>=1 <6']), [
      '1.0.0',
      '>=2.0.0 <3.0.0',
      '>=3.0.0 <4.0.0',
      '>=4.0.0 <5.0.0',
      '>=1 <6',
    ])
  })

  it('de-duplicates a shared floor across multiple ranges', () => {
    assert.deepEqual(keys('mongodb', ['>=2 <3', '^2.0.0']), ['2.0.0', '>=2 <3', '^2.0.0'])
  })

  it('does not fill in-between majors for non-consecutive packages', () => {
    assert.deepEqual(keys('mongodb', ['>=1 <6'], new Set(['mongodb'])), ['1.0.0', '>=1 <6'])
  })

  it('treats the built-in non-consecutive packages as floor + range only', () => {
    // graphql jumps from 0.x to 14.x; auto-filling 1.x–13.x would fail the install.
    assert.deepEqual(keys('graphql', ['>=0.10']), ['0.10.0', '>=0.10'])
  })

  it('throws on an unparseable range', () => {
    assert.throws(() => getVersionList('mongodb', ['not-a-version']), /Invalid version range/)
  })

  it('ignores empty entries', () => {
    assert.deepEqual(keys('mongodb', ['', undefined, '>=2 <3']), ['2.0.0', '>=2 <3'])
  })
})

describe('resolvePluginVersions', () => {
  const versionKeys = result => result.versionList.map(({ versionKey }) => versionKey)

  it('expands the declared versions and points the unversioned folder at the newest in-scope key', () => {
    const result = resolvePluginVersions({ name: 'mongodb', declaredVersions: ['>=2 <5'], env: {} })

    assert.deepEqual(versionKeys(result), ['2.0.0', '>=3.0.0 <4.0.0', '>=2 <5'])
    assert.equal(result.unversioned, '>=2 <5')
  })

  it('filters the installed keys by RANGE and follows the filtered tail', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=1 <6'],
      env: { RANGE: '>=2.0.0 <4.0.0' },
    })

    assert.deepEqual(versionKeys(result), ['>=2.0.0 <3.0.0', '>=3.0.0 <4.0.0'])
    assert.equal(result.unversioned, '>=3.0.0 <4.0.0')
  })

  it('replaces the declared versions with PACKAGE_VERSION_RANGE when the module is honoured', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=2 <5'],
      env: { PACKAGE_VERSION_RANGE: '>=3 <4' },
    })

    assert.deepEqual(versionKeys(result), ['3.0.0', '>=3 <4'])
    assert.equal(result.unversioned, '>=3 <4')
  })

  it('ignores PACKAGE_VERSION_RANGE for a sibling external that must not be sharded', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=2 <5'],
      honourEnvRange: false,
      env: { PACKAGE_VERSION_RANGE: '>=3 <4' },
    })

    assert.deepEqual(versionKeys(result), ['2.0.0', '>=3.0.0 <4.0.0', '>=2 <5'])
    assert.equal(result.unversioned, '>=2 <5')
  })

  it('keeps the unversioned folder on the raw shard while RANGE narrows the installed keys', () => {
    const result = resolvePluginVersions({
      name: 'mongodb',
      declaredVersions: ['>=1 <6'],
      env: { PACKAGE_VERSION_RANGE: '>=2 <5', RANGE: '>=3.0.0 <4.0.0' },
    })

    assert.deepEqual(versionKeys(result), ['>=3.0.0 <4.0.0'])
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
