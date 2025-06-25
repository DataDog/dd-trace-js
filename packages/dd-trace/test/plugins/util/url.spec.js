'use strict'

const t = require('tap')
require('../../setup/core')

const { filterSensitiveInfoFromRepository } = require('../../../src/plugins/util/url')

t.test('filterSensitiveInfoFromRepository', t => {
  t.test('returns the same url if no sensitive info is present', t => {
    const urls = [
      'http://example.com/repository.git',
      'https://datadog.com/repository.git',
      'ssh://host.xz:port/path/to/repo.git/',
      'git@github.com:DataDog/dd-trace-js.git'
    ]
    urls.forEach(url => {
      expect(filterSensitiveInfoFromRepository(url)).to.equal(url)
    })
    t.end()
  })

  t.test('returns the scrubbed url if credentials are present', t => {
    const sensitiveUrls = [
      'https://username:password@datadog.com/repository.git',
      'ssh://username@host.xz:port/path/to/repo.git/',
      'https://username@datadog.com/repository.git'
    ]
    expect(filterSensitiveInfoFromRepository(sensitiveUrls[0])).to.equal('https://datadog.com/repository.git')
    expect(filterSensitiveInfoFromRepository(sensitiveUrls[1])).to.equal('ssh://host.xz:port/path/to/repo.git/')
    expect(filterSensitiveInfoFromRepository(sensitiveUrls[2])).to.equal('https://datadog.com/repository.git')
    t.end()
  })

  t.test('does not crash for empty or invalid repository URLs', t => {
    const invalidUrls = [
      null,
      '',
      undefined,
      '1+1=2'
    ]
    invalidUrls.forEach(url => {
      expect(filterSensitiveInfoFromRepository(url)).to.equal('')
    })
    t.end()
  })
  t.end()
})
