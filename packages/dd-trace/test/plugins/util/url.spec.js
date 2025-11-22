'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha

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
      expect(result).to.equal('http://example.com:8080/path/to/resource')
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
      expect(result).to.equal('http://example.com/original/path')
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
      expect(result).to.equal('https://secure.example.com/secure/path')
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
      expect(result).to.equal('https://secure.example.com/secure/path')
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
      expect(result).to.equal('https://example.com:443/api/v1/users')
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
      expect(result).to.equal('http://localhost:3000/search?q=test&page=2')
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

      expect(result).to.equal(urlPath + qs)
    })

    it('should not obfuscate when no querystring is found', () => {
      const result = url.obfuscateQs(config, urlPath)

      expect(result).to.equal(urlPath)
    })

    it('should remove the querystring if passed true', () => {
      config.queryStringObfuscation = true

      const result = url.obfuscateQs(config, urlPath + qs)

      expect(result).to.equal(urlPath)
    })

    it('should obfuscate only the querystring part of the url', () => {
      const result = url.obfuscateQs(config, urlPath + 'secret/' + qs)

      expect(result).to.equal(urlPath + 'secret/?data=<redacted>')
    })
  })

  describe('extractPathFromUrl', () => {
    it('should return / for empty or missing url', () => {
      expect(url.extractPathFromUrl('')).to.equal('/')
      expect(url.extractPathFromUrl(null)).to.equal('/')
      expect(url.extractPathFromUrl(undefined)).to.equal('/')
      expect(url.extractPathFromUrl('http://example.com')).to.equal('/')
    })

    it('should extract path from full URLs', () => {
      expect(url.extractPathFromUrl('http://localhost:3000/users/123'))
        .to.equal('/users/123')
      expect(url.extractPathFromUrl('https://api.example.com/v1/items'))
        .to.equal('/v1/items')
    })

    it('should handle relative paths', () => {
      expect(url.extractPathFromUrl('/users/123')).to.equal('/users/123')
      expect(url.extractPathFromUrl('/api/v1/users')).to.equal('/api/v1/users')
    })

    it('should strip query strings', () => {
      expect(url.extractPathFromUrl('http://localhost/users/123?sort=asc&limit=10'))
        .to.equal('/users/123')
      expect(url.extractPathFromUrl('/api/search?q=test&page=2'))
        .to.equal('/api/search')
      expect(url.extractPathFromUrl('https://example.com?foo=bar')).to.equal('/')
    })

    it('should handle root path', () => {
      expect(url.extractPathFromUrl('http://localhost/')).to.equal('/')
      expect(url.extractPathFromUrl('/')).to.equal('/')
    })

    it('should handle IPv6 hosts', () => {
      expect(url.extractPathFromUrl('http://[::1]/users?id=123'))
        .to.equal('/users')
    })
  })

  describe('calculateHttpEndpoint', () => {
    describe('Basic examples', () => {
      it('should handle typical REST API patterns', () => {
        expect(url.calculateHttpEndpoint('/v1/users/12345/posts/67890'))
          .to.equal('/v1/users/{param:int}/posts/{param:int}')

        expect(url.calculateHttpEndpoint('/files/a1b2c3d4e5f6/download'))
          .to.equal('/files/{param:hex}/download')
      })

      it('should handle session/token endpoints', () => {
        expect(url.calculateHttpEndpoint('/api/sessions/a1b2c3d4e5f6'))
          .to.equal('/api/sessions/{param:hex}')
      })

      it('should handle search and query endpoints', () => {
        expect(url.calculateHttpEndpoint('/search/hello%20world'))
          .to.equal('/search/{param:str}')

        expect(url.calculateHttpEndpoint('/api/query/status=active&type=premium'))
          .to.equal('/api/query/{param:str}')
      })

      it('should handle version prefixes correctly', () => {
        expect(url.calculateHttpEndpoint('/v1/users')).to.equal('/v1/users')
        expect(url.calculateHttpEndpoint('/v2/products')).to.equal('/v2/products')
      })
    })

    describe('Edge cases and URL extraction', () => {
      it('should return / for empty or missing url', () => {
        expect(url.calculateHttpEndpoint('')).to.equal('/')
        expect(url.calculateHttpEndpoint(null)).to.equal('/')
        expect(url.calculateHttpEndpoint(undefined)).to.equal('/')
      })

      it('should handle root path', () => {
        expect(url.calculateHttpEndpoint('http://localhost/')).to.equal('/')
        expect(url.calculateHttpEndpoint('/')).to.equal('/')
      })

      it('should extract path from full URLs', () => {
        expect(url.calculateHttpEndpoint('http://localhost:3000/users/123')).to.equal('/users/{param:int}')
        expect(url.calculateHttpEndpoint('https://api.example.com/v1/items')).to.equal('/v1/items')
      })

      it('should strip query strings', () => {
        expect(url.calculateHttpEndpoint('http://localhost/users/123?sort=asc&limit=10'))
          .to.equal('/users/{param:int}')
        expect(url.calculateHttpEndpoint('/api/search?q=test&page=2'))
          .to.equal('/api/search')
      })
    })

    describe('Path segment normalization', () => {
      it('should keep simple path elements as is', () => {
        expect(url.calculateHttpEndpoint('http://localhost/users/profile')).to.equal('/users/profile')
        expect(url.calculateHttpEndpoint('/api/v1/users')).to.equal('/api/v1/users')
      })

      it('should replace integers with {param:int} >= 2 digits', () => {
        expect(url.calculateHttpEndpoint('http://localhost/users/123')).to.equal('/users/{param:int}')
        expect(url.calculateHttpEndpoint('/users/456/posts/789')).to.equal('/users/{param:int}/posts/{param:int}')
        expect(url.calculateHttpEndpoint('/orders/123')).to.equal('/orders/{param:int}')
      })

      it('should NOT replace single digit numbers', () => {
        expect(url.calculateHttpEndpoint('/api/v1/users')).to.equal('/api/v1/users')
        expect(url.calculateHttpEndpoint('/v2/products')).to.equal('/v2/products')
        expect(url.calculateHttpEndpoint('/tier/3/access')).to.equal('/tier/3/access')
      })

      it('should replace mixed digit strings with delimiters as {param:int_id}', () => {
        expect(url.calculateHttpEndpoint('/users/123-456')).to.equal('/users/{param:int_id}')
        expect(url.calculateHttpEndpoint('/users/123_456')).to.equal('/users/{param:int_id}')
        expect(url.calculateHttpEndpoint('/users/123.456')).to.equal('/users/{param:int_id}')
      })

      it('should replace hex strings (≥6 chars, has digit) with {param:hex}', () => {
        expect(url.calculateHttpEndpoint('/session/a1b2c3d4e5f6')).to.equal('/session/{param:hex}')
        expect(url.calculateHttpEndpoint('/token/ABCDEF123456')).to.equal('/token/{param:hex}')
        expect(url.calculateHttpEndpoint('/hash/deadbeef1234')).to.equal('/hash/{param:hex}')
      })

      it('should replace mixed hex with delimiters as {param:hex_id}', () => {
        expect(url.calculateHttpEndpoint('/id/a1b2c3-d4e5f6')).to.equal('/id/{param:hex_id}')
        expect(url.calculateHttpEndpoint('/uuid/abc123_def456')).to.equal('/uuid/{param:hex_id}')
        expect(url.calculateHttpEndpoint('/uuid/abc123.def456')).to.equal('/uuid/{param:hex_id}')
      })

      it('should replace long strings (≥20 chars) with {param:str}', () => {
        expect(url.calculateHttpEndpoint('/files/this_is_a_very_long_filename_indeed'))
          .to.equal('/files/{param:str}')
      })

      it('should replace strings with special characters as {param:str}', () => {
        expect(url.calculateHttpEndpoint('/search/hello%20world')).to.equal('/search/{param:str}')
        expect(url.calculateHttpEndpoint('/filter/foo&bar')).to.equal('/filter/{param:str}')
        expect(url.calculateHttpEndpoint('/query/test@example')).to.equal('/query/{param:str}')
        expect(url.calculateHttpEndpoint('/path/name=value')).to.equal('/path/{param:str}')
        expect(url.calculateHttpEndpoint('/encoded/foo%2Fbar')).to.equal('/encoded/{param:str}')
      })
    })

    describe('Path segment limits', () => {
      it('should limit to 8 path segments', () => {
        const longPath = '/a/b/c/d/e/f/g/h/i/j/k'
        expect(url.calculateHttpEndpoint(longPath)).to.equal('/a/b/c/d/e/f/g/h')
      })

      it('should filter empty path segments', () => {
        expect(url.calculateHttpEndpoint('/users//123///posts')).to.equal('/users/{param:int}/posts')
        expect(url.calculateHttpEndpoint('///api///v1///users')).to.equal('/api/v1/users')
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
        expect(url.filterSensitiveInfoFromRepository(repoUrl)).to.equal(repoUrl)
      })
    })

    it('returns the scrubbed url if credentials are present', () => {
      const sensitiveUrls = [
        'https://username:password@datadog.com/repository.git',
        'ssh://username@host.xz:port/path/to/repo.git/',
        'https://username@datadog.com/repository.git'
      ]
      expect(url.filterSensitiveInfoFromRepository(sensitiveUrls[0])).to.equal('https://datadog.com/repository.git')
      expect(url.filterSensitiveInfoFromRepository(sensitiveUrls[1])).to.equal('ssh://host.xz:port/path/to/repo.git/')
      expect(url.filterSensitiveInfoFromRepository(sensitiveUrls[2])).to.equal('https://datadog.com/repository.git')
    })

    it('does not crash for empty or invalid repository URLs', () => {
      const invalidUrls = [
        null,
        '',
        undefined,
        '1+1=2'
      ]
      invalidUrls.forEach(repoUrl => {
        expect(url.filterSensitiveInfoFromRepository(repoUrl)).to.equal('')
      })
    })
  })
})
