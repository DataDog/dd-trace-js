'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('tap').mocha

require('../../setup/core')

const { filterSensitiveInfoFromRepository } = require('../../../src/plugins/util/url')

describe('filterSensitiveInfoFromRepository', () => {
  it('returns the same url if no sensitive info is present', () => {
    const urls = [
      'http://example.com/repository.git',
      'https://datadog.com/repository.git',
      'ssh://host.xz:port/path/to/repo.git/',
      'git@github.com:DataDog/dd-trace-js.git'
    ]
    urls.forEach(url => {
      assert.strictEqual(filterSensitiveInfoFromRepository(url), url)
    })
  })

  it('returns the scrubbed url if credentials are present', () => {
    const sensitiveUrls = [
      'https://username:password@datadog.com/repository.git',
      'ssh://username@host.xz:port/path/to/repo.git/',
      'https://username@datadog.com/repository.git'
    ]
    assert.strictEqual(filterSensitiveInfoFromRepository(sensitiveUrls[0]), 'https://datadog.com/repository.git')
    assert.strictEqual(filterSensitiveInfoFromRepository(sensitiveUrls[1]), 'ssh://host.xz:port/path/to/repo.git/')
    assert.strictEqual(filterSensitiveInfoFromRepository(sensitiveUrls[2]), 'https://datadog.com/repository.git')
  })

  it('does not crash for empty or invalid repository URLs', () => {
    const invalidUrls = [
      null,
      '',
      undefined,
      '1+1=2'
    ]
    invalidUrls.forEach(url => {
      assert.strictEqual(filterSensitiveInfoFromRepository(url), '')
    })
  })
})
