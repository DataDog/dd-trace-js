'use strict'

const assert = require('node:assert/strict')

const {
  HTTP_STATUS_ERROR,
  INSTRUMENTATION_HTTP_RESOURCE,
  applyHttpOtelSemantics,
  decomposeServerUrl,
  runHttpRequestHook,
} = require('../../../src/plugins/util/http-otel-semantics')

describe('http-otel-semantics', () => {
  describe('runHttpRequestHook', () => {
    it('does not read span tags when OTel semantics are disabled', () => {
      const span = {
        context: () => {
          throw new Error('context must not be read')
        },
      }
      let received

      runHttpRequestHook(span, (hookSpan, arg1, arg2) => {
        received = [hookSpan, arg1, arg2]
      }, 'request', 'response')

      assert.deepStrictEqual(received, [span, 'request', 'response'])
    })
  })

  describe('decomposeServerUrl', () => {
    it('splits scheme, address, port, path, and query', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('http://localhost:8200/a/b?demo=1', 'http://localhost:8200/a/b?demo=1'),
        { scheme: 'http', address: 'localhost', port: '8200', path: '/a/b', query: 'demo=1' }
      )
    })

    it('omits the port when it is the scheme default', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('https://example.com/p', 'https://example.com/p'),
        { scheme: 'https', address: 'example.com', port: undefined, path: '/p', query: undefined }
      )
    })

    it('keeps an explicit non-default port and omits an absent query', () => {
      const parts = decomposeServerUrl('http://h:8080/', 'http://h:8080/')
      assert.strictEqual(parts.path, '/')
      assert.strictEqual(parts.port, '8080')
      assert.strictEqual(parts.query, undefined)
    })

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
      // Every attribute goes out as a `meta` string on the agent protocol; the OTLP
      // transformer is what restores the int typing.
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
      const { meta } = run(
        {
          'span.kind': 'server',
          'http.method': 'GET',
          'http.url': 'http://localhost:8080/u?x=1',
          'http.status_code': '500',
          'http.useragent': 'ua',
          'http.client_ip': '1.2.3.4',
          'http.endpoint': '/u',
          [HTTP_STATUS_ERROR]: 'true',
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
      assert.strictEqual(meta['user_agent.original'], 'ua')
      assert.strictEqual(meta['client.address'], '1.2.3.4')
      assert.strictEqual(meta['http.response.status_code'], '500')
      assert.strictEqual(meta['error.type'], '500')
      assert.ok(!('http.url' in meta))
      assert.ok(!('http.useragent' in meta))
      assert.ok(!('http.client_ip' in meta))
    })

    it('retains http.endpoint, which is Datadog-only with no OTel equivalent', () => {
      // ASM and endpoint aggregation read this key, so it survives the rename on
      // both the agent and the OTLP payload.
      const { meta } = run({
        'span.kind': 'server',
        'http.method': 'GET',
        'http.url': 'http://h/users/1',
        'http.endpoint': '/users/{id}',
      })

      assert.strictEqual(meta['http.endpoint'], '/users/{id}')
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

    it('removes internal provenance when a hook cleared the HTTP attributes', () => {
      const { meta } = run({
        'span.kind': 'server',
        [INSTRUMENTATION_HTTP_RESOURCE]: 'GET',
        [HTTP_STATUS_ERROR]: 'true',
      })

      assert.deepStrictEqual(meta, { 'span.kind': 'server' })
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
      serverSpan.meta[INSTRUMENTATION_HTTP_RESOURCE] = serverSpan.resource
      applyHttpOtelSemantics(serverSpan)
      assert.strictEqual(serverSpan.resource, 'HTTP')

      const clientSpan = {
        meta: { 'span.kind': 'client', 'http.method': 'PROPFIND', 'http.url': 'http://h/p' },
        metrics: {},
        error: 0,
        resource: 'PROPFIND',
      }
      clientSpan.meta[INSTRUMENTATION_HTTP_RESOURCE] = clientSpan.resource
      applyHttpOtelSemantics(clientSpan)
      assert.strictEqual(clientSpan.resource, 'HTTP')
    })

    it('does not use the URL path when a server route is absent', () => {
      const span = {
        meta: { 'span.kind': 'server', 'http.method': 'GET', 'http.url': 'http://h/not/a/route' },
        metrics: {},
        error: 0,
        resource: 'GET /not/a/route',
      }
      span.meta[INSTRUMENTATION_HTTP_RESOURCE] = span.resource
      applyHttpOtelSemantics(span)
      assert.strictEqual(span.resource, 'GET')
    })

    it('uses the route in a known-method server span name', () => {
      const span = {
        meta: {
          'span.kind': 'server',
          'http.method': 'GET',
          'http.route': '/users/{id}',
          'http.url': 'http://h/users/1',
        },
        metrics: {},
        error: 0,
        resource: 'GET',
      }
      span.meta[INSTRUMENTATION_HTTP_RESOURCE] = span.resource
      applyHttpOtelSemantics(span)
      assert.strictEqual(span.resource, 'GET /users/{id}')
    })

    it('preserves a user-defined HTTP resource name', () => {
      const span = {
        meta: {
          'span.kind': 'server',
          'http.method': 'GET',
          'http.route': '/users/{id}',
          'http.url': 'http://h/users/1',
        },
        metrics: {},
        error: 0,
        resource: 'checkout-custom',
      }

      applyHttpOtelSemantics(span)

      assert.strictEqual(span.resource, 'checkout-custom')
    })

    for (const resource of ['GET /custom', 'GET checkout']) {
      it(`preserves a manually assigned method-prefixed resource: ${resource}`, () => {
        const span = {
          meta: {
            'span.kind': 'server',
            'http.method': 'GET',
            'http.route': '/users/{id}',
            'http.url': 'http://h/users/1',
            [INSTRUMENTATION_HTTP_RESOURCE]: 'GET',
          },
          metrics: {},
          error: 0,
          resource,
        }

        applyHttpOtelSemantics(span)

        assert.strictEqual(span.resource, resource)
      })
    }

    // Whether an HTTP status makes the span an error is decided at capture time,
    // from the configured error-status ranges (see http-error-statuses.js). Trace
    // stats run after this transform and consume that same decision. The transform only derives
    // `error.type` from the decision the span already carries, and never changes
    // `error` itself.
    it('derives error.type from the error the span already carries', () => {
      const errored = run(
        {
          'span.kind': 'server',
          'http.method': 'GET',
          'http.status_code': '503',
          'http.url': 'http://h/p',
          [HTTP_STATUS_ERROR]: 'true',
        },
        {},
        1
      )
      assert.strictEqual(errored.meta['error.type'], '503')
      assert.strictEqual(errored.error, 1)
    })

    it('never turns a non-error span into an error, whatever the status', () => {
      for (const status of ['404', '500', '503']) {
        const span = run(
          { 'span.kind': 'server', 'http.method': 'GET', 'http.status_code': status, 'http.url': 'http://h/p' },
          {},
          0
        )
        assert.strictEqual(span.error, 0, `status ${status} must not flip error`)
        assert.ok(!('error.type' in span.meta), `status ${status} must not set error.type`)
      }
    })

    it('sets error.type on an errored client span', () => {
      for (const status of ['404', '503']) {
        const span = run(
          {
            'span.kind': 'client',
            'http.method': 'GET',
            'http.status_code': status,
            'http.url': 'http://h/p',
            [HTTP_STATUS_ERROR]: 'true',
          },
          {},
          1
        )
        assert.strictEqual(span.meta['error.type'], status)
      }
    })

    it('still renames what a hook left behind after stripping the method and URL', () => {
      // The marker proves instrumentation touched this span, so the status and user agent
      // captured at finish must not keep their Datadog names.
      const span = run(
        {
          'span.kind': 'server',
          'http.status_code': '503',
          'http.useragent': 'ua',
          [INSTRUMENTATION_HTTP_RESOURCE]: 'GET',
        },
        {},
        1
      )

      assert.strictEqual(span.meta['http.response.status_code'], '503')
      assert.strictEqual(span.meta['user_agent.original'], 'ua')
      assert.ok(!Object.hasOwn(span.meta, 'http.status_code'))
      assert.ok(!Object.hasOwn(span.meta, 'http.useragent'))
      assert.ok(!Object.hasOwn(span.meta, INSTRUMENTATION_HTTP_RESOURCE))
    })

    it('leaves a span the semantics layer never touched alone', () => {
      const span = run({ 'span.kind': 'client', 'db.name': 'orders' }, {}, 0)

      assert.deepStrictEqual(span.meta, { 'span.kind': 'client', 'db.name': 'orders' })
    })

    it('drops a numeric copy of a derived attribute so OTLP cannot carry it twice', () => {
      // A hook setting a numeric value lands in `metrics`, while the attribute is derived into
      // `meta` from the legacy key. Exporting both would emit the attribute twice.
      const span = run(
        {
          'span.kind': 'server',
          'http.method': 'GET',
          'http.url': 'http://h:8080/p',
          'http.status_code': '500',
        },
        { 'http.response.status_code': 200, 'server.port': 9999 }
      )

      assert.strictEqual(span.meta['http.response.status_code'], '500')
      assert.strictEqual(span.meta['server.port'], '8080')
      assert.ok(!Object.hasOwn(span.metrics, 'http.response.status_code'))
      assert.ok(!Object.hasOwn(span.metrics, 'server.port'))
    })

    it('does not blame the status for an error the application recorded itself', () => {
      // A request hook can mark a span as an error while the response status stays inside the
      // validator's accepted range. Capture time leaves the status-error marker off in that
      // case, so the status must not be reported as the cause.
      for (const kind of ['server', 'client']) {
        for (const status of ['404', '500']) {
          const span = run(
            { 'span.kind': kind, 'http.method': 'GET', 'http.status_code': status, 'http.url': 'http://h/p' },
            {},
            1
          )
          assert.strictEqual(span.error, 1)
          assert.ok(
            !Object.hasOwn(span.meta, 'error.type'),
            `${kind} span with an accepted status ${status} must not set error.type`
          )
        }
      }
    })

    it('sets error.type for a successful status when a validator caused the error', () => {
      const span = run(
        {
          'span.kind': 'client',
          'http.method': 'GET',
          'http.status_code': '200',
          'http.url': 'http://h/p',
          [HTTP_STATUS_ERROR]: 'true',
        },
        {},
        1
      )

      assert.strictEqual(span.meta['error.type'], '200')
      assert.ok(!Object.hasOwn(span.meta, HTTP_STATUS_ERROR))
    })

    it('does not describe a manual error on a successful response as a status error', () => {
      const span = run(
        { 'span.kind': 'client', 'http.method': 'GET', 'http.status_code': '200', 'http.url': 'http://h/p' },
        {},
        1
      )

      assert.ok(!Object.hasOwn(span.meta, 'error.type'))
    })

    it('emits the status code verbatim, without reparsing it', () => {
      // `span_format` already stringified the status, so whatever it holds is passed
      // straight through rather than being parsed into a number.
      const { meta } = run({
        'span.kind': 'client',
        'http.method': 'GET',
        'http.status_code': '404',
        'http.url': 'http://h/p',
      })

      assert.strictEqual(meta['http.response.status_code'], '404')
    })
  })
})
