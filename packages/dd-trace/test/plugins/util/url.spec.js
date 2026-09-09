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
          host: 'example.com:8080',
        },
        url: '/path/to/resource',
        socket: null,
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'http://example.com:8080/path/to/resource')
    })

    it('should extract full URL from HTTP/1.x request with originalUrl', () => {
      const req = {
        headers: {
          host: 'example.com',
        },
        url: '/path',
        originalUrl: '/original/path',
        socket: null,
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'http://example.com/original/path')
    })

    it('should extract full URL from HTTPS request with socket.encrypted', () => {
      const req = {
        headers: {
          host: 'secure.example.com',
        },
        url: '/secure/path',
        socket: { encrypted: true },
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'https://secure.example.com/secure/path')
    })

    it('should not read `connection.encrypted` (deprecated alias for `socket.encrypted`)', () => {
      const req = {
        headers: {
          host: 'secure.example.com',
        },
        url: '/secure/path',
        socket: null,
        connection: { encrypted: true },
      }

      const result = url.extractURL(req)
      assert.strictEqual(result, 'http://secure.example.com/secure/path')
    })

    it('should extract full URL from HTTP/2 request', () => {
      const req = {
        stream: {},
        headers: {
          ':scheme': 'https',
          ':authority': 'example.com:443',
          ':path': '/api/v1/users',
        },
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
          ':path': '/search?q=test&page=2',
        },
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
        queryStringObfuscation: /secret/gi,
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

  describe('buildClientHttpUrl', () => {
    const base = 'http://perdu.com'
    const strippedUrl = 'http://perdu.com/path'

    it('returns the stripped url when there is no query', () => {
      const config = { queryStringObfuscation: 'secret' }

      assert.strictEqual(url.buildClientHttpUrl(config, base, '/path', strippedUrl), strippedUrl)
    })

    it('includes the query with sensitive values obfuscated', () => {
      const config = { queryStringObfuscation: 'secret' }

      assert.strictEqual(
        url.buildClientHttpUrl(config, base, '/path?data=secret', strippedUrl),
        'http://perdu.com/path?data=<redacted>'
      )
    })

    it('drops the query when query-string obfuscation is set to true', () => {
      const config = { queryStringObfuscation: true }

      assert.strictEqual(url.buildClientHttpUrl(config, base, '/path?data=secret', strippedUrl), strippedUrl)
    })

    it('keeps the raw query when query-string obfuscation is disabled', () => {
      const config = { queryStringObfuscation: false }

      assert.strictEqual(
        url.buildClientHttpUrl(config, base, '/path?data=secret', strippedUrl),
        'http://perdu.com/path?data=secret'
      )
    })
  })

  describe('ClientQueryStringSchema', () => {
    const base = 'http://example.com'
    const strippedUrl = `${base}/search`

    let schema

    beforeEach(() => {
      schema = new url.ClientQueryStringSchema()
    })

    /**
     * @param {string} pathname
     * @param {{
     *   queryStringAllowlist?: Set<string>,
     *   queryStringObfuscation?: boolean | string | RegExp,
     *   queryStringTaggingEnabled?: boolean
     * }} [config]
     * @param {string} [source]
     * @returns {string}
     */
    function getUrl (pathname, config = {}, source) {
      return schema.getUrl(config, pathname, strippedUrl, source)
    }

    /**
     * @param {string} pathname
     * @param {{
     *   queryStringAllowlist?: Set<string>,
     *   queryStringObfuscation?: boolean | string | RegExp,
     *   queryStringTaggingEnabled?: boolean
     * }} [config]
     * @param {string} [source]
     * @returns {string}
     */
    function admit (pathname, config = {}, source) {
      getUrl(pathname, config, source)
      getUrl(pathname, config, source)
      return getUrl(pathname, config, source)
    }

    it('reports a canonical schema from the third observation', () => {
      const pathname = '/search?' + [
        'uuid=4f45f5d2-7682-4f1e-9d02-8c3b652a7a4f',
        'number=-12.5e3',
        'date=2026-09-09T12%3A30%3A00Z',
        'ipv4=192.0.2.1',
        'ipv6=2001%3Adb8%3A%3A1',
        'boolean=true',
        'empty=',
        'flag',
        'text=hello',
      ].join('&')
      const reorderedPathname = '/search?' + pathname.slice(pathname.indexOf('?') + 1).split('&').reverse().join('&')
      const expected = `${strippedUrl}?` + [
        'boolean=<boolean>',
        'date=<date>',
        'empty=<empty>',
        'flag=<flag>',
        'ipv4=<IPv4>',
        'ipv6=<IPv6>',
        'number=<number>',
        'text=<string>',
        'uuid=<uuid>',
      ].join('&')

      assert.strictEqual(getUrl(pathname), strippedUrl)
      assert.strictEqual(getUrl(reorderedPathname), strippedUrl)
      assert.strictEqual(getUrl(pathname), expected)
      assert.strictEqual(getUrl(pathname), expected)
    })

    it('collapses duplicate keys with different types', () => {
      const pathname = '/search?tag=1&tag=2&tag=text'

      assert.strictEqual(getUrl(pathname), strippedUrl)
      assert.strictEqual(getUrl(pathname), strippedUrl)
      assert.strictEqual(getUrl(pathname), `${strippedUrl}?tag=<mixed>`)
    })

    it('does not combine observations from overlapping client integrations', () => {
      const pathname = '/search?page=2'

      assert.strictEqual(getUrl(pathname, {}, 'undici:request:create'), strippedUrl)
      assert.strictEqual(getUrl(pathname, {}, 'undici'), strippedUrl)
      assert.strictEqual(getUrl(pathname, {}, 'undici:request:create'), strippedUrl)
      assert.strictEqual(getUrl(pathname, {}, 'undici'), strippedUrl)
      assert.strictEqual(getUrl(pathname, {}, 'undici:request:create'), `${strippedUrl}?page=<number>`)
      assert.strictEqual(getUrl(pathname, {}, 'undici'), `${strippedUrl}?page=<number>`)
    })

    it('filters query keys through an allowlist', () => {
      const config = { queryStringAllowlist: new Set(['page']) }
      const pathname = '/search?query=secret&page=2'

      assert.strictEqual(getUrl(pathname, config), strippedUrl)
      assert.strictEqual(getUrl(pathname, config), strippedUrl)
      assert.strictEqual(getUrl(pathname, config), `${strippedUrl}?page=<number>`)
    })

    it('retains raw values only when obfuscation is explicitly disabled', () => {
      const config = { queryStringObfuscation: false }
      const pathname = '/search?query=hello&page=2'

      assert.strictEqual(getUrl(pathname, config), strippedUrl)
      assert.strictEqual(getUrl(pathname, config), strippedUrl)
      assert.strictEqual(getUrl(pathname, config), `${base}${pathname}`)
    })

    it('replaces configured sensitive values before admission', () => {
      const config = { queryStringObfuscation: /(?:password|token)=/ }
      const pathname = '/search?password=secret&page=2'

      assert.strictEqual(getUrl(pathname, config), strippedUrl)
      assert.strictEqual(getUrl(pathname, config), strippedUrl)
      assert.strictEqual(getUrl(pathname, config), `${strippedUrl}?page=<number>&password=<redacted>`)
    })

    it('bounds malformed and oversized query strings', () => {
      const malformed = '/search?value=%E0%A4%A'
      const oversized = `/search?value=${'x'.repeat(2048)}`

      assert.strictEqual(getUrl(malformed), strippedUrl)
      assert.strictEqual(getUrl(malformed), strippedUrl)
      assert.strictEqual(getUrl(malformed), `${strippedUrl}?value=<string>`)

      assert.strictEqual(getUrl(oversized), strippedUrl)
      assert.strictEqual(getUrl(oversized), strippedUrl)
      assert.strictEqual(getUrl(oversized), `${strippedUrl}?value=<string>&<truncated>`)
    })

    it('handles query structure and output length boundaries', () => {
      assert.strictEqual(getUrl('/search'), strippedUrl)
      assert.strictEqual(getUrl('/search?'), strippedUrl)
      assert.strictEqual(admit('/search?page=2#fragment'), `${strippedUrl}?page=<number>`)
      assert.strictEqual(getUrl('/search?page=2', { queryStringAllowlist: new Set() }), strippedUrl)

      const rawConfig = {
        queryStringAllowlist: new Set(['page']),
        queryStringObfuscation: false,
      }
      assert.strictEqual(admit('/search?secret=value&page=2&page=3', rawConfig), `${strippedUrl}?page=2&page=3`)
      assert.strictEqual(getUrl(`/search?page=${'1'.repeat(2049)}`, rawConfig), strippedUrl)
      assert.strictEqual(getUrl('/search?secret=value', rawConfig), strippedUrl)
      assert.strictEqual(getUrl('/search?page=2', {
        queryStringAllowlist: new Set(),
        queryStringObfuscation: false,
      }), strippedUrl)
      assert.strictEqual(admit('/search?flag&other=value', {
        queryStringAllowlist: new Set(['flag']),
        queryStringObfuscation: false,
      }), `${strippedUrl}?flag`)

      const rawParameters = []
      for (let index = 0; index < 17; index++) rawParameters.push(`page=${index}`)
      const admittedRawUrl = admit(`/search?${rawParameters.join('&')}`, rawConfig)
      assert.strictEqual(admittedRawUrl.slice(admittedRawUrl.indexOf('?') + 1).split('&').length, 16)

      const longStrippedUrl = `${base}/${'x'.repeat(2048)}`
      assert.strictEqual(schema.getUrl({}, '/search?page=2', longStrippedUrl), longStrippedUrl)
      assert.strictEqual(schema.getUrl({}, '/search?page=2', longStrippedUrl), longStrippedUrl)
      assert.strictEqual(schema.getUrl({}, '/search?page=2', longStrippedUrl), longStrippedUrl)
    })

    it('classifies encoded numbers and hexadecimal values without decoding malformed escapes', () => {
      const pathname = '/search?' + [
        'hex=0x1f',
        'badHex=0x1g',
        'shortHex=0x',
        'exponent=1e%2B2',
        'badExponent=1e%2B',
        'plus=a+b',
        'escaped=a%2fb%20%zz',
      ].join('&')
      const expected = `${strippedUrl}?` + [
        'badExponent=<string>',
        'badHex=<string>',
        'escaped=<string>',
        'exponent=<number>',
        'hex=<hex>',
        'plus=<string>',
        'shortHex=<string>',
      ].join('&')

      assert.strictEqual(admit(pathname), expected)
    })

    it('canonicalizes UTF-8 query keys and allowlist entries', () => {
      const allowlist = url.normalizeQueryStringAllowlist('caf%C3%A9')
      const config = { queryStringAllowlist: allowlist }
      const expected = `${strippedUrl}?caf%C3%A9=<number>`

      assert.deepStrictEqual([...allowlist], ['café'])
      assert.strictEqual(getUrl('/search?café=1', config), strippedUrl)
      assert.strictEqual(getUrl('/search?caf%C3%A9=2', config), strippedUrl)
      assert.strictEqual(getUrl('/search?caf%C3%A9=3', config), expected)
      assert.strictEqual(admit('/search?bad%zz=1'), `${strippedUrl}?bad%25zz=<number>`)

      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist('caf+%C3%A9')], ['caf é'])
      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist('😀%20x')], ['😀 x'])
      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist('\uD800%20x,\uDC00%20x')], [
        '\uD800%20x',
        '\uDC00%20x',
      ])
      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist('%ED%9F%BF,%F0%90%80%80,%F4%8F%BF%BF')], [
        '퟿',
        '𐀀',
        '􏿿',
      ])
      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist('%ED%A0%80,%F0%80%80%80,%F4%90%80%80,%80')], [
        '%ED%A0%80',
        '%F0%80%80%80',
        '%F4%90%80%80',
        '%80',
      ])
    })

    it('bounds query keys, parameters, and the canonical schema', () => {
      const longKey = 'a'.repeat(65)
      assert.strictEqual(admit(`/search?${longKey}=hello&123=world`), `${strippedUrl}?<key>=<string>`)

      const parameters = []
      for (let index = 0; index < 17; index++) {
        parameters.push(`${'k'.repeat(61)}${String(index).padStart(3, '0')}=value`)
      }
      const admittedUrl = admit(`/search?${parameters.join('&')}`)
      const admittedQuery = admittedUrl.slice(admittedUrl.indexOf('?') + 1)

      assert.match(admittedQuery, /&<truncated>$/)
      assert.ok(admittedQuery.length <= 512)
    })

    it('counts every supported client producer independently', () => {
      for (const [index, source] of ['electron:net:request', 'fetch'].entries()) {
        const pathname = `/search/${index}?page=2`
        const sourceUrl = `${base}/search/${index}`

        assert.strictEqual(schema.getUrl({}, pathname, sourceUrl, source), sourceUrl)
        assert.strictEqual(schema.getUrl({}, pathname, sourceUrl, source), sourceUrl)
        assert.strictEqual(schema.getUrl({}, pathname, sourceUrl, source), `${sourceUrl}?page=<number>`)
      }
    })

    it('strips the query when collection or obfuscation is disabled', () => {
      assert.strictEqual(getUrl('/search?page=2', { queryStringTaggingEnabled: false }), strippedUrl)
      assert.strictEqual(getUrl('/search?page=2', { queryStringObfuscation: true }), strippedUrl)
    })

    it('does not replace admitted schemas after reaching the limit', () => {
      for (let index = 0; index < 32; index++) {
        const path = `/search/${index}?page=${index}`
        const stripped = `${base}/search/${index}`
        assert.strictEqual(schema.getUrl({}, path, stripped), stripped)
        assert.strictEqual(schema.getUrl({}, path, stripped), stripped)
        assert.strictEqual(schema.getUrl({}, path, stripped), `${stripped}?page=<number>`)
      }

      const overflowPath = '/search/overflow?page=33'
      const overflowUrl = `${base}/search/overflow`
      assert.strictEqual(schema.getUrl({}, overflowPath, overflowUrl), overflowUrl)
      assert.strictEqual(schema.getUrl({}, overflowPath, overflowUrl), overflowUrl)
      assert.strictEqual(schema.getUrl({}, overflowPath, overflowUrl), overflowUrl)
    })

    it('bounds probation state before a schema is promoted', () => {
      for (let index = 0; index < 65; index++) {
        const path = `/search/${index}?page=${index}`
        schema.getUrl({}, path, `${base}/search/${index}`)
      }

      const pathname = '/search/0?page=0'
      const stripped = `${base}/search/0`
      assert.strictEqual(schema.getUrl({}, pathname, stripped), stripped)
      assert.strictEqual(schema.getUrl({}, pathname, stripped), stripped)
      assert.strictEqual(schema.getUrl({}, pathname, stripped), `${stripped}?page=<number>`)
    })

    it('normalizes allowlist configuration once', () => {
      const allowlist = new Set(['page'])

      assert.strictEqual(url.normalizeQueryStringAllowlist(undefined), undefined)
      assert.strictEqual(url.normalizeQueryStringAllowlist(allowlist), allowlist)
      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist(' page,query,page ')], ['page', 'query'])
      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist(['page', '', 1, 'query'])], ['page', 'query'])
      assert.strictEqual(url.normalizeQueryStringAllowlist('*'), undefined)
      assert.deepStrictEqual([...url.normalizeQueryStringAllowlist('')], [])
      assert.strictEqual(url.normalizeQueryStringAllowlist({}), undefined)
    })
  })

  describe('getQsObfuscator', () => {
    it('passes booleans through', () => {
      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: true }), true)
      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: false }), false)
    })

    it('passes regular expressions through', () => {
      const obfuscator = /password=/

      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: obfuscator }), obfuscator)
    })

    it('treats an empty string as disabled and ".*" as a full redaction', () => {
      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: '' }), false)
      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: '.*' }), true)
    })

    it('compiles a regex string and caches the compiled result', () => {
      const first = url.getQsObfuscator({ queryStringObfuscation: 'token' })
      assert.ok(first instanceof RegExp)
      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: 'token' }), first)
    })

    it('falls back to full redaction on an invalid regex or a non-string/boolean value', () => {
      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: '[' }), true)
      assert.strictEqual(url.getQsObfuscator({ queryStringObfuscation: 123 }), true)
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

      it('should treat 20 chars as the {param:str} length boundary', () => {
        // 19 plain chars (no digit, no special) stay verbatim; 20 cross into {param:str}.
        assert.strictEqual(url.calculateHttpEndpoint('/x/abcdefghijklmnopqrs'), '/x/abcdefghijklmnopqrs')
        assert.strictEqual(url.calculateHttpEndpoint('/x/abcdefghijklmnopqrst'), '/x/{param:str}')
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
        'git@github.com:DataDog/dd-trace-js.git',
      ]
      urls.forEach(repoUrl => {
        assert.strictEqual(url.filterSensitiveInfoFromRepository(repoUrl), repoUrl)
      })
    })

    it('returns the scrubbed url if credentials are present', () => {
      const sensitiveUrls = [
        'https://username:password@datadog.com/repository.git',
        'ssh://username@host.xz:port/path/to/repo.git/',
        'https://username@datadog.com/repository.git',
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
        '1+1=2',
      ]
      invalidUrls.forEach(repoUrl => {
        assert.strictEqual(url.filterSensitiveInfoFromRepository(repoUrl), '')
      })
    })
  })
})
