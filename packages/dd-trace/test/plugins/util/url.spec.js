'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../../setup/core')

describe('plugins/util/url', () => {
  let url

  beforeEach(() => {
    url = require('../../../src/plugins/util/url')
  })

  describe('extractURL', () => {
    it('should extract full URL from HTTP/1.x request', () => {
      const req = {
        headers: {
          host: 'example.com:8080'
        },
        url: '/path/to/resource',
        socket: null
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'http://example.com:8080/path/to/resource')
    })

    it('should extract full URL from HTTP/1.x request with originalUrl', () => {
      const req = {
        headers: {
          host: 'example.com'
        },
        url: '/path',
        originalUrl: '/original/path',
        socket: null
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'http://example.com/original/path')
    })

    it('should extract full URL from HTTPS request with socket.encrypted', () => {
      const req = {
        headers: {
          host: 'secure.example.com'
        },
        url: '/secure/path',
        socket: { encrypted: true }
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'https://secure.example.com/secure/path')
    })

    it('should extract full URL from HTTPS request with connection.encrypted', () => {
      const req = {
        headers: {
          host: 'secure.example.com'
        },
        url: '/secure/path',
        socket: null,
        connection: { encrypted: true }
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'https://secure.example.com/secure/path')
    })

    it('should extract full URL from HTTP/2 request', () => {
      const req = {
        stream: {},
        headers: {
          ':scheme': 'https',
          ':authority': 'example.com:443',
          ':path': '/api/v1/users'
        }
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'https://example.com:443/api/v1/users')
    })

    it('should handle HTTP/2 request with query string', () => {
      const req = {
        stream: {},
        headers: {
          ':scheme': 'http',
          ':authority': 'localhost:3000',
          ':path': '/search?q=test&page=2'
        }
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'http://localhost:3000/search?q=test&page=2')
    })
  })

  describe('obfuscateQs', () => {
    const urlPath = 'http://perdu.com/path/'
    const qs = '?data=secret'

    let config

    beforeEach(() => {
      config = {
        queryStringObfuscation: /secret/gi
      }
    })

    it('should not obfuscate when passed false', () => {
      config.queryStringObfuscation = false

      const result = url.obfuscateQs(config, urlPath + qs)

      assert.strictEqual(result, urlPath + qs)
    })

    it('should not obfuscate when no querystring is found', () => {
      const result = url.obfuscateQs(config, urlPath)

      assert.strictEqual(result, urlPath)
    })

    it('should remove the querystring if passed true', () => {
      config.queryStringObfuscation = true

      const result = url.obfuscateQs(config, urlPath + qs)

      assert.strictEqual(result, urlPath)
    })

    it('should obfuscate only the querystring part of the url', () => {
      const result = url.obfuscateQs(config, urlPath + 'secret/' + qs)

      assert.strictEqual(result, urlPath + 'secret/?data=<redacted>')
    })
  })

  describe('extractPathFromUrl', () => {
    it('should return / for empty or missing url', () => {
      assert.strictEqual(url.extractPathFromUrl(''), '/')
      assert.strictEqual(url.extractPathFromUrl(null), '/')
      assert.strictEqual(url.extractPathFromUrl(undefined), '/')
      assert.strictEqual(url.extractPathFromUrl('http://example.com'), '/')
    })

    it('should extract path from full URLs', () => {
      assert.strictEqual(url.extractPathFromUrl('http://localhost:3000/users/123'), '/users/123')
      assert.strictEqual(url.extractPathFromUrl('https://api.example.com/v1/items'), '/v1/items')
    })

    it('should handle relative paths', () => {
      assert.strictEqual(url.extractPathFromUrl('/users/123'), '/users/123')
      assert.strictEqual(url.extractPathFromUrl('/api/v1/users'), '/api/v1/users')
    })

    it('should strip query strings', () => {
      assert.strictEqual(url.extractPathFromUrl('http://localhost/users/123?sort=asc&limit=10'), '/users/123')
      assert.strictEqual(url.extractPathFromUrl('/api/search?q=test&page=2'), '/api/search')
      assert.strictEqual(url.extractPathFromUrl('https://example.com?foo=bar'), '/')
    })

    it('should handle root path', () => {
      assert.strictEqual(url.extractPathFromUrl('http://localhost/'), '/')
      assert.strictEqual(url.extractPathFromUrl('/'), '/')
    })

    it('should handle IPv6 hosts', () => {
      assert.strictEqual(url.extractPathFromUrl('http://[::1]/users?id=123'), '/users')
    })
  })

  describe('calculateHttpEndpoint', () => {
    describe('Basic examples', () => {
      it('should handle typical REST API patterns', () => {
        assert.strictEqual(
          url.calculateHttpEndpoint('/v1/users/12345/posts/67890'),
          '/v1/users/{param:int}/posts/{param:int}'
        )

        assert.strictEqual(
          url.calculateHttpEndpoint('/files/a1b2c3d4e5f6/download'),
          '/files/{param:hex}/download'
        )
      })

      it('should handle session/token endpoints', () => {
        assert.strictEqual(
          url.calculateHttpEndpoint('/api/sessions/a1b2c3d4e5f6'),
          '/api/sessions/{param:hex}'
        )
      })

      it('should handle search and query endpoints', () => {
        assert.strictEqual(
          url.calculateHttpEndpoint('/search/hello%20world'),
          '/search/{param:str}'
        )

        assert.strictEqual(
          url.calculateHttpEndpoint('/api/query/status=active&type=premium'),
          '/api/query/{param:str}'
        )
      })

      it('should handle version prefixes correctly', () => {
        assert.strictEqual(url.calculateHttpEndpoint('/v1/users'), '/v1/users')
        assert.strictEqual(url.calculateHttpEndpoint('/v2/products'), '/v2/products')
      })
    })

    describe('Edge cases and URL extraction', () => {
      it('should return / for empty or missing url', () => {
        assert.strictEqual(url.calculateHttpEndpoint(''), '/')
        assert.strictEqual(url.calculateHttpEndpoint(null), '/')
        assert.strictEqual(url.calculateHttpEndpoint(undefined), '/')
      })

      it('should handle root path', () => {
        assert.strictEqual(url.calculateHttpEndpoint('http://localhost/'), '/')
        assert.strictEqual(url.calculateHttpEndpoint('/'), '/')
      })

      it('should extract path from full URLs', () => {
        assert.strictEqual(url.calculateHttpEndpoint('http://localhost:3000/users/123'), '/users/{param:int}')
        assert.strictEqual(url.calculateHttpEndpoint('https://api.example.com/v1/items'), '/v1/items')
      })

      it('should strip query strings', () => {
        assert.strictEqual(
          url.calculateHttpEndpoint('http://localhost/users/123?sort=asc&limit=10'),
          '/users/{param:int}'
        )
        assert.strictEqual(
          url.calculateHttpEndpoint('/api/search?q=test&page=2'),
          '/api/search'
        )
      })
    })

    describe('Path segment normalization', () => {
      it('should keep simple path elements as is', () => {
        assert.strictEqual(url.calculateHttpEndpoint('http://localhost/users/profile'), '/users/profile')
        assert.strictEqual(url.calculateHttpEndpoint('/api/v1/users'), '/api/v1/users')
      })

      it('should replace integers with {param:int} >= 2 digits', () => {
        assert.strictEqual(url.calculateHttpEndpoint('http://localhost/users/123'), '/users/{param:int}')
        assert.strictEqual(url.calculateHttpEndpoint('/users/456/posts/789'), '/users/{param:int}/posts/{param:int}')
        assert.strictEqual(url.calculateHttpEndpoint('/orders/123'), '/orders/{param:int}')
      })

      it('should NOT replace single digit numbers', () => {
        assert.strictEqual(url.calculateHttpEndpoint('/api/v1/users'), '/api/v1/users')
        assert.strictEqual(url.calculateHttpEndpoint('/v2/products'), '/v2/products')
        assert.strictEqual(url.calculateHttpEndpoint('/tier/3/access'), '/tier/3/access')
      })

      it('should replace mixed digit strings with delimiters as {param:int_id}', () => {
        assert.strictEqual(url.calculateHttpEndpoint('/users/123-456'), '/users/{param:int_id}')
        assert.strictEqual(url.calculateHttpEndpoint('/users/123_456'), '/users/{param:int_id}')
        assert.strictEqual(url.calculateHttpEndpoint('/users/123.456'), '/users/{param:int_id}')
      })

      it('should replace hex strings (≥6 chars, has digit) with {param:hex}', () => {
        assert.strictEqual(url.calculateHttpEndpoint('/session/a1b2c3d4e5f6'), '/session/{param:hex}')
        assert.strictEqual(url.calculateHttpEndpoint('/token/ABCDEF123456'), '/token/{param:hex}')
        assert.strictEqual(url.calculateHttpEndpoint('/hash/deadbeef1234'), '/hash/{param:hex}')
      })

      it('should replace mixed hex with delimiters as {param:hex_id}', () => {
        assert.strictEqual(url.calculateHttpEndpoint('/id/a1b2c3-d4e5f6'), '/id/{param:hex_id}')
        assert.strictEqual(url.calculateHttpEndpoint('/uuid/abc123_def456'), '/uuid/{param:hex_id}')
        assert.strictEqual(url.calculateHttpEndpoint('/uuid/abc123.def456'), '/uuid/{param:hex_id}')
      })

      it('should replace long strings (≥20 chars) with {param:str}', () => {
        assert.strictEqual(
          url.calculateHttpEndpoint('/files/this_is_a_very_long_filename_indeed'),
          '/files/{param:str}'
        )
      })

      it('should replace strings with special characters as {param:str}', () => {
        assert.strictEqual(url.calculateHttpEndpoint('/search/hello%20world'), '/search/{param:str}')
        assert.strictEqual(url.calculateHttpEndpoint('/filter/foo&bar'), '/filter/{param:str}')
        assert.strictEqual(url.calculateHttpEndpoint('/query/test@example'), '/query/{param:str}')
        assert.strictEqual(url.calculateHttpEndpoint('/path/name=value'), '/path/{param:str}')
        assert.strictEqual(url.calculateHttpEndpoint('/encoded/foo%2Fbar'), '/encoded/{param:str}')
      })
    })

    describe('Path segment limits', () => {
      it('should limit to 8 path segments', () => {
        const longPath = '/a/b/c/d/e/f/g/h/i/j/k'
        assert.strictEqual(url.calculateHttpEndpoint(longPath), '/a/b/c/d/e/f/g/h')
      })

      it('should filter empty path segments', () => {
        assert.strictEqual(url.calculateHttpEndpoint('/users//123///posts'), '/users/{param:int}/posts')
        assert.strictEqual(url.calculateHttpEndpoint('///api///v1///users'), '/api/v1/users')
      })
    })
  })

  describe('filterSensitiveInfoFromRepository', () => {
    it('returns the same url if no sensitive info is present', () => {
      const urls = [
        'http://example.com/repository.git',
        'https://datadog.com/repository.git',
        'ssh://host.xz:port/path/to/repo.git/',
        'git@github.com:DataDog/dd-trace-js.git'
      ]
      urls.forEach(repoUrl => {
        assert.strictEqual(url.filterSensitiveInfoFromRepository(repoUrl), repoUrl)
      })
    })

    it('returns the scrubbed url if credentials are present', () => {
      const sensitiveUrls = [
        'https://username:password@datadog.com/repository.git',
        'ssh://username@host.xz:port/path/to/repo.git/',
        'https://username@datadog.com/repository.git'
      ]
      assert.strictEqual(url.filterSensitiveInfoFromRepository(sensitiveUrls[0]), 'https://datadog.com/repository.git')
      assert.strictEqual(url.filterSensitiveInfoFromRepository(sensitiveUrls[1]), 'ssh://host.xz:port/path/to/repo.git/')
      assert.strictEqual(url.filterSensitiveInfoFromRepository(sensitiveUrls[2]), 'https://datadog.com/repository.git')
    })

    it('does not crash for empty or invalid repository URLs', () => {
      const invalidUrls = [
        null,
        '',
        undefined,
        '1+1=2'
      ]
      invalidUrls.forEach(repoUrl => {
        assert.strictEqual(url.filterSensitiveInfoFromRepository(repoUrl), '')
      })
    })
  })
})
