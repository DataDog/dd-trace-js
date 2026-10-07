'use strict'

const assert = require('node:assert/strict')

const { applyHttpOtelSemantics, decomposeServerUrl } = require('../../../src/plugins/util/http-otel-semantics')

describe('http-otel-semantics', () => {
  describe('decomposeServerUrl', () => {
    it('splits scheme, address, port, path, and query', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('http://localhost:8200/a/b?demo=1', 'http://localhost:8200/a/b?demo=1'),
        { scheme: 'http', address: 'localhost', port: '8200', path: '/a/b', query: 'demo=1' }
      )
    })

    it('includes the scheme default port', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('https://example.com/p', 'https://example.com/p'),
        { scheme: 'https', address: 'example.com', port: '443', path: '/p', query: undefined }
      )
    })

    it('keeps an explicit non-default port and omits an absent query', () => {
      const parts = decomposeServerUrl('http://h:8080/', 'http://h:8080/')
      assert.strictEqual(parts.path, '/')
      assert.strictEqual(parts.port, '8080')
      assert.strictEqual(parts.query, undefined)
    })

    for (const [scheme, port] of [['http', '80'], ['https', '443'], ['ws', '80'], ['wss', '443']]) {
      for (const suffix of ['', `:${port}`]) {
        it(`includes the ${scheme} default port with authority suffix ${JSON.stringify(suffix)}`, () => {
          const url = `${scheme}://example.com${suffix}/p`
          assert.strictEqual(decomposeServerUrl(url, url).port, port)
        })
      }
    }

    for (const url of ['http://h:0/p', 'https://undefined:8080/p', '/p', 'http://[bad]/p', 'file:///p']) {
      it(`does not derive a server port from ${url}`, () => {
        assert.strictEqual(decomposeServerUrl(url, url).port, undefined)
      })
    }

    it('takes the query from the obfuscated URL so redaction is preserved', () => {
      const parts = decomposeServerUrl('http://h/x?secret=1', 'http://h/x?<redacted>')
      assert.strictEqual(parts.query, '<redacted>')
    })

    it('strips brackets from an IPv6 server.address', () => {
      const parts = decomposeServerUrl('http://[::1]:8080/p', 'http://[::1]:8080/p')
      assert.strictEqual(parts.address, '::1')
      assert.strictEqual(parts.port, '8080')
    })

    it('omits server.address when the Host header is absent', () => {
      // extractURL builds `http://undefined/...` when req.headers.host is missing.
      const parts = decomposeServerUrl('http://undefined/p', 'http://undefined/p')
      assert.strictEqual(parts.address, undefined)
      assert.strictEqual(parts.port, undefined)
      assert.strictEqual(parts.path, '/p')
    })

    it('falls back to the root path for a malformed URL while still reading its query', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('not-a-valid-url?x=1', 'not-a-valid-url?x=1'),
        { scheme: undefined, address: undefined, port: undefined, path: '/', query: 'x=1' }
      )
    })
  })

  describe('applyHttpOtelSemantics', () => {
    const run = (meta, metrics = {}, error = 0) => {
      const span = { meta, metrics, error }
      applyHttpOtelSemantics(span)
      return span
    }

    it('renames client attributes and removes the Datadog ones', () => {
      const { meta, metrics } = run(
        {
          'span.kind': 'client',
          'http.method': 'GET',
          'http.url': 'http://localhost:8080/u?x=1',
          'out.host': 'localhost',
          'http.status_code': '200',
        },
        { 'network.destination.port': 8080 }
      )

      assert.strictEqual(meta['http.request.method'], 'GET')
      assert.strictEqual(meta['url.full'], 'http://localhost:8080/u?x=1')
      assert.strictEqual(meta['server.address'], 'localhost')
      assert.strictEqual(meta['http.response.status_code'], '200')
      assert.strictEqual(meta['server.port'], '8080')
      assert.ok(!('http.response.status_code' in metrics))
      assert.ok(!('server.port' in metrics))
      assert.ok(!('http.method' in meta))
      assert.ok(!('http.url' in meta))
      assert.ok(!('out.host' in meta))
      assert.ok(!('http.status_code' in meta))
      assert.ok(!('network.destination.port' in metrics))
    })

    it('decomposes the URL and renames attributes for a server span', () => {
      const { meta, metrics } = run(
        {
          'span.kind': 'server',
          'http.method': 'GET',
          'http.url': 'http://localhost:8080/u?x=1',
          'http.status_code': '500',
          'http.useragent': 'ua',
          'http.client_ip': '1.2.3.4',
          'http.endpoint': '/u',
        },
        {},
        1
      )

      assert.strictEqual(meta['http.request.method'], 'GET')
      assert.strictEqual(meta['url.path'], '/u')
      assert.strictEqual(meta['url.scheme'], 'http')
      assert.strictEqual(meta['url.query'], 'x=1')
      assert.strictEqual(meta['server.address'], 'localhost')
      assert.strictEqual(meta['server.port'], '8080')
      assert.ok(!('server.port' in metrics))
      assert.strictEqual(meta['user_agent.original'], 'ua')
      assert.strictEqual(meta['client.address'], '1.2.3.4')
      assert.strictEqual(meta['http.response.status_code'], '500')
      assert.ok(!('http.response.status_code' in metrics))
      assert.strictEqual(meta['error.type'], '500')
      assert.ok(!('http.url' in meta))
      assert.strictEqual(meta['http.endpoint'], '/u')
      assert.ok(!('http.useragent' in meta))
      assert.ok(!('http.client_ip' in meta))
    })

    for (const [status, expected] of [['0200', '200'], ['+1', '1'], ['1e2', '1'], [' 200 ', '200'],
      ['500oops', '500']]) {
      it(`keeps legacy parseInt conversion for ${JSON.stringify(status)}`, () => {
        const span = run({ 'http.method': 'GET', 'span.kind': 'client', 'http.status_code': status })
        assert.strictEqual(span.meta['http.response.status_code'], expected)
        assert.strictEqual(span.error, Number(Number(expected) >= 400))
        assert.strictEqual(span.meta['error.type'], Number(expected) >= 400 ? status : undefined)
      })
    }

    it('uses valid legacy status before canonical meta and metrics', () => {
      const span = run({
        'http.method': 'GET',
        'http.status_code': '0200',
        'http.response.status_code': '201',
      }, { 'http.response.status_code': 202 })
      assert.strictEqual(span.meta['http.response.status_code'], '200')
      assert.ok(!Object.hasOwn(span.metrics, 'http.response.status_code'))
    })

    for (const legacy of ['bogus', '9007199254740992']) {
      for (const canonical of ['204', 'bogus']) {
        it(`uses a valid canonical fallback after legacy ${legacy} and canonical meta ${canonical}`, () => {
          const span = run({
            'http.method': 'GET',
            'http.status_code': legacy,
            'http.response.status_code': canonical,
          }, { 'http.response.status_code': 205 })
          assert.strictEqual(span.meta['http.response.status_code'], canonical === '204' ? '204' : '205')
          assert.ok(!Object.hasOwn(span.metrics, 'http.response.status_code'))
          // Classification still uses the original legacy parseInt result, not the fallback.
          assert.strictEqual(span.error, legacy === 'bogus' ? 0 : 1)
        })
      }
    }

    for (const key of ['http.response.status_code', 'server.port']) {
      for (const value of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, -1,
        String(Number.MAX_SAFE_INTEGER), String(Number.MIN_SAFE_INTEGER), '0', '-1']) {
        it(`keeps safe canonical ${key} ${JSON.stringify(value)} as string meta`, () => {
          const span = run({ 'http.method': 'GET', [key]: value }, { [key]: 204 })
          assert.strictEqual(span.meta[key], String(value))
          assert.ok(!Object.hasOwn(span.metrics, key))
        })
      }
      for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1,
        '9007199254740992', '-9007199254740992', '0200', '+1', '1e2', ' 200 ', '', '-0',
        1.5, '1.5', NaN, Infinity, null, true]) {
        it(`rejects non-canonical ${key} ${String(value)} without losing valid metric`, () => {
          const span = run({ 'http.method': 'GET', [key]: value }, { [key]: 204 })
          assert.strictEqual(span.meta[key], '204')
          assert.ok(!Object.hasOwn(span.metrics, key))
          const invalid = run({ 'http.method': 'GET', [key]: value }, { [key]: value })
          assert.ok(!Object.hasOwn(invalid.meta, key))
          assert.ok(!Object.hasOwn(invalid.metrics, key))
        })
      }
    }

    it('uses derived ports before canonical values and valid fallbacks after invalid destinations', () => {
      const clientMeta = { 'http.method': 'GET', 'server.port': '443' }
      assert.strictEqual(run(clientMeta, { 'network.destination.port': 8080, 'server.port': 80 })
        .meta['server.port'], '8080')
      assert.strictEqual(run(clientMeta, { 'network.destination.port': NaN, 'server.port': 80 })
        .meta['server.port'], '443')
      assert.strictEqual(run({ ...clientMeta, 'server.port': 'bad' }, {
        'network.destination.port': NaN,
        'server.port': 80,
      }).meta['server.port'], '80')
      assert.strictEqual(run({ ...clientMeta, 'span.kind': 'server', 'http.url': 'http://h/p' })
        .meta['server.port'], '80')
    })

    it('retains both endpoint and route for aggregation without changing the resource', () => {
      const span = {
        meta: { 'http.method': 'GET', 'http.endpoint': '/users/{param:int}', 'http.route': '/users/:id' },
        metrics: {},
        resource: 'custom',
        error: 1,
      }
      applyHttpOtelSemantics(span)
      assert.strictEqual(span.meta['http.endpoint'], '/users/{param:int}')
      assert.strictEqual(span.meta['http.route'], '/users/:id')
      assert.strictEqual(span.resource, 'custom')
      assert.strictEqual(span.error, 1)
    })

    it('does not classify canonical fallback statuses or clear existing errors', () => {
      const span = run({
        'http.method': 'GET',
        'http.status_code': 'bogus',
        'http.response.status_code': '503',
      })
      assert.strictEqual(span.error, 0)
      assert.strictEqual(span.meta['error.type'], undefined)
      assert.strictEqual(run({ 'http.method': 'GET', 'http.status_code': '200' }, {}, 1).error, 1)
    })

    it('remaps ws/wss schemes to http/https', () => {
      assert.strictEqual(run({ 'span.kind': 'server', 'http.url': 'ws://h/chat' }).meta['url.scheme'], 'http')
      assert.strictEqual(run({ 'span.kind': 'server', 'http.url': 'wss://h/chat' }).meta['url.scheme'], 'https')
    })

    it('does not overwrite an exception-derived error.type', () => {
      const { meta } = run(
        { 'span.kind': 'server', 'http.method': 'GET', 'http.status_code': '500', 'error.type': 'Error' },
        {},
        1
      )

      assert.strictEqual(meta['error.type'], 'Error')
    })

    it('preserves non-HTTP meta and metrics keys through the rebuild', () => {
      const { meta, metrics } = run(
        {
          'span.kind': 'server',
          component: 'express',
          '_dd.base_service': 'svc',
          'http.method': 'GET',
          'http.url': 'http://h/p',
          'http.status_code': '200',
        },
        { '_dd.measured': 1, _sampling_priority_v1: 1 }
      )

      assert.strictEqual(meta.component, 'express')
      assert.strictEqual(meta['_dd.base_service'], 'svc')
      assert.strictEqual(metrics['_dd.measured'], 1)
      assert.strictEqual(metrics._sampling_priority_v1, 1)
    })

    it('leaves non-HTTP spans untouched', () => {
      const { meta } = run({ 'span.kind': 'client', 'db.system': 'redis' })

      assert.deepStrictEqual(meta, { 'span.kind': 'client', 'db.system': 'redis' })
    })

    it('normalizes an unknown HTTP method to _OTHER and preserves the original', () => {
      const { meta } = run({ 'span.kind': 'server', 'http.method': 'PROPFIND', 'http.url': 'http://h/p' })

      assert.strictEqual(meta['http.request.method'], '_OTHER')
      assert.strictEqual(meta['http.request.method_original'], 'PROPFIND')
    })

    it('passes a known HTTP method through without method_original', () => {
      const { meta } = run({ 'span.kind': 'server', 'http.method': 'GET', 'http.url': 'http://h/p' })

      assert.strictEqual(meta['http.request.method'], 'GET')
      assert.ok(!('http.request.method_original' in meta))
    })

    it('redacts credentials embedded in a client url.full', () => {
      assert.strictEqual(
        run({ 'span.kind': 'client', 'http.url': 'https://user:pass@h:8443/p?q=1' }).meta['url.full'],
        'https://REDACTED:REDACTED@h:8443/p?q=1'
      )
      assert.strictEqual(
        run({ 'span.kind': 'client', 'http.url': 'http://user@h/p' }).meta['url.full'],
        'http://REDACTED@h/p'
      )
      // userinfo extends to the last '@' in the authority — redact all of it.
      assert.strictEqual(
        run({ 'span.kind': 'client', 'http.url': 'http://user:p@ss@h/p' }).meta['url.full'],
        'http://REDACTED:REDACTED@h/p'
      )
      assert.strictEqual(
        run({ 'span.kind': 'client', 'http.url': 'https://h/p' }).meta['url.full'],
        'https://h/p'
      )
    })

    it('falls back to the scheme default port for a client without an explicit port', () => {
      assert.strictEqual(run({ 'span.kind': 'client', 'http.url': 'https://h/p' }).meta['server.port'], '443')
      assert.strictEqual(run({ 'span.kind': 'client', 'http.url': 'http://h/p' }).meta['server.port'], '80')
      assert.strictEqual(
        run({ 'span.kind': 'client', 'http.url': 'http://h:8080/p' }, { 'network.destination.port': 8080 })
          .meta['server.port'],
        '8080'
      )
    })

    it('strips IPv6 brackets from a client server.address (matching the server path)', () => {
      const { meta } = run(
        { 'span.kind': 'client', 'http.url': 'http://[::1]:8080/p', 'out.host': '[::1]' },
        { 'network.destination.port': 8080 }
      )

      assert.strictEqual(meta['server.address'], '::1')
    })

    it('uses "HTTP" in the span name for an unknown method', () => {
      const serverSpan = {
        meta: { 'span.kind': 'server', 'http.method': 'PROPFIND', 'http.url': 'http://h/p' },
        metrics: {},
        error: 0,
        resource: 'PROPFIND /p',
      }
      applyHttpOtelSemantics(serverSpan)
      assert.strictEqual(serverSpan.resource, 'HTTP /p')

      const clientSpan = {
        meta: { 'span.kind': 'client', 'http.method': 'PROPFIND', 'http.url': 'http://h/p' },
        metrics: {},
        error: 0,
        resource: 'PROPFIND',
      }
      applyHttpOtelSemantics(clientSpan)
      assert.strictEqual(clientSpan.resource, 'HTTP')
    })

    it('leaves a known-method span name unchanged', () => {
      const span = {
        meta: { 'span.kind': 'server', 'http.method': 'GET', 'http.url': 'http://h/users/1' },
        metrics: {},
        error: 0,
        resource: 'GET /users/{id}',
      }
      applyHttpOtelSemantics(span)
      assert.strictEqual(span.resource, 'GET /users/{id}')
    })

    it('marks a server 5xx as an error with error.type, but never a server 4xx', () => {
      const e503 = run({ 'span.kind': 'server', 'http.method': 'GET', 'http.status_code': '503', 'http.url': 'http://h/p' })
      assert.strictEqual(e503.meta['error.type'], '503')
      assert.strictEqual(e503.error, 1)

      const e404 = run({ 'span.kind': 'server', 'http.method': 'GET', 'http.status_code': '404', 'http.url': 'http://h/p' })
      assert.ok(!('error.type' in e404.meta))
    })

    it('sets error.type for client 4xx and 5xx', () => {
      assert.strictEqual(
        run({ 'span.kind': 'client', 'http.method': 'GET', 'http.status_code': '404', 'http.url': 'http://h/p' })
          .meta['error.type'],
        '404'
      )
      assert.strictEqual(
        run({ 'span.kind': 'client', 'http.method': 'GET', 'http.status_code': '503', 'http.url': 'http://h/p' })
          .meta['error.type'],
        '503'
      )
    })

    it('omits canonical status and error.type when the status is non-numeric', () => {
      const { meta, metrics } = run({
        'span.kind': 'client',
        'http.method': 'GET',
        'http.status_code': 'bogus',
        'http.url': 'http://h/p',
      })

      assert.ok(!('http.response.status_code' in metrics))
      assert.ok(!('http.response.status_code' in meta))
      assert.ok(!('error.type' in meta))
    })
  })
})
