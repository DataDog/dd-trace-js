'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const { normalizeRouteExpress } = require('../../../src/appsec/api_security/normalized-route-express')

describe('normalizeRouteExpress', () => {
  describe('invalid / unsupported inputs', () => {
    it('returns null for null', () => {
      assert.equal(normalizeRouteExpress(null, {}), null)
    })

    it('returns null for undefined', () => {
      assert.equal(normalizeRouteExpress(undefined, {}), null)
    })

    it('returns null for empty string', () => {
      assert.equal(normalizeRouteExpress('', {}), null)
    })

    it('returns null for non-string', () => {
      assert.equal(normalizeRouteExpress(42, {}), null)
    })

    it('returns null for regex-encoded route (starts with "(")', () => {
      assert.equal(normalizeRouteExpress('(/^/user/([0-9]+)$/i)', {}), null)
    })

    it('returns null for route with standalone parentheses (optional group)', () => {
      assert.equal(normalizeRouteExpress('/path(\\.ext)?', {}), null)
    })

    it('returns null for route with Express 5 {/...} optional group syntax', () => {
      assert.equal(normalizeRouteExpress('/users{/:id}', {}), null)
    })
  })

  describe('root and trivial routes', () => {
    it('returns "/" for root route', () => {
      assert.equal(normalizeRouteExpress('/', {}), '/')
    })

    it('preserves trailing slash when declared', () => {
      assert.equal(normalizeRouteExpress('/users/', {}), '/users/')
    })

    it('does not add trailing slash when not declared', () => {
      assert.equal(normalizeRouteExpress('/users', {}), '/users')
    })
  })

  describe('static routes', () => {
    it('preserves plain ASCII static segments', () => {
      assert.equal(normalizeRouteExpress('/api/v1/users', {}), '/api/v1/users')
    })

    it('preserves dots and dashes in static segments', () => {
      assert.equal(normalizeRouteExpress('/api/v2.0/some-path', {}), '/api/v2.0/some-path')
    })

    it('URL-encodes characters outside the allowed static set', () => {
      assert.equal(normalizeRouteExpress('/api/hello world', {}), '/api/hello%20world')
    })

    it('URL-encodes special chars in static segments', () => {
      assert.equal(normalizeRouteExpress('/path/foo!bar', {}), '/path/foo%21bar')
    })
  })

  describe('required named params', () => {
    it('normalizes a single required param', () => {
      assert.equal(normalizeRouteExpress('/users/:id', { id: '123' }), '/users/{id}')
    })

    it('normalizes multiple required params in separate segments', () => {
      assert.equal(
        normalizeRouteExpress('/users/:userId/posts/:postId', { userId: '1', postId: '2' }),
        '/users/{userId}/posts/{postId}'
      )
    })

    it('normalizes static and dynamic segments mixed', () => {
      assert.equal(
        normalizeRouteExpress('/api/v1/users/:id', { id: '42' }),
        '/api/v1/users/{id}'
      )
    })

    it('strips inline regex constraint (Express 4 :name(regexp))', () => {
      assert.equal(normalizeRouteExpress('/users/:id(\\d+)', { id: '5' }), '/users/{id}')
    })

    it('works when params is null (required params still included)', () => {
      assert.equal(normalizeRouteExpress('/users/:id', null), '/users/{id}')
    })

    it('works when params is undefined', () => {
      assert.equal(normalizeRouteExpress('/users/:id', undefined), '/users/{id}')
    })
  })

  describe('optional named params', () => {
    it('includes optional param when present in req.params', () => {
      assert.equal(normalizeRouteExpress('/users/:id?', { id: '123' }), '/users/{id}')
    })

    it('drops optional param segment when absent from req.params', () => {
      assert.equal(normalizeRouteExpress('/users/:id?', {}), '/users')
    })

    it('drops optional param segment when params is undefined', () => {
      assert.equal(normalizeRouteExpress('/users/:id?', undefined), '/users')
    })

    it('drops optional param segment when params is null', () => {
      assert.equal(normalizeRouteExpress('/users/:id?', null), '/users')
    })

    it('handles optional param in the middle — present', () => {
      assert.equal(
        normalizeRouteExpress('/api/:version?/users', { version: 'v1' }),
        '/api/{version}/users'
      )
    })

    it('handles optional param in the middle — absent', () => {
      assert.equal(normalizeRouteExpress('/api/:version?/users', {}), '/api/users')
    })

    it('handles optional param with inline regex constraint (Express 4) — present', () => {
      assert.equal(normalizeRouteExpress('/items/:id(\\d+)?', { id: '7' }), '/items/{id}')
    })

    it('handles optional param with inline regex constraint (Express 4) — absent', () => {
      assert.equal(normalizeRouteExpress('/items/:id(\\d+)?', {}), '/items')
    })
  })

  describe('multi-param segments (rule 5)', () => {
    it('combines two required params in one segment with "+"', () => {
      assert.equal(
        normalizeRouteExpress('/photos/:id.:format', { id: '1', format: 'jpg' }),
        '/photos/{id+format}'
      )
    })

    it('combines two params separated by a dash', () => {
      assert.equal(
        normalizeRouteExpress('/range/:from-:to', { from: 'a', to: 'z' }),
        '/range/{from+to}'
      )
    })

    it('combines three params in one segment', () => {
      assert.equal(
        normalizeRouteExpress('/v/:major.:minor.:patch', { major: '1', minor: '2', patch: '3' }),
        '/v/{major+minor+patch}'
      )
    })

    it('drops absent optional in multi-param segment — both optional, both absent → skip segment', () => {
      assert.equal(normalizeRouteExpress('/photos/:id?.:format?', {}), '/photos')
    })

    it('drops absent optional in multi-param segment — one present', () => {
      assert.equal(
        normalizeRouteExpress('/photos/:id.:format?', { id: '1' }),
        '/photos/{id}'
      )
    })

    it('includes all present params in multi-param combination', () => {
      assert.equal(
        normalizeRouteExpress('/photos/:id.:format?', { id: '1', format: 'jpg' }),
        '/photos/{id+format}'
      )
    })

    it('single param with surrounding static text becomes just the param (rule 5)', () => {
      assert.equal(
        normalizeRouteExpress('/users/user-:id', { id: '5' }),
        '/users/{id}'
      )
    })
  })

  describe('unnamed catch-all wildcard (*)', () => {
    it('normalizes trailing * to {param1}', () => {
      assert.equal(normalizeRouteExpress('/files/*', { 0: 'a/b/c' }), '/files/{param1}')
    })

    it('normalizes bare * route to /{param1}', () => {
      assert.equal(normalizeRouteExpress('/*', {}), '/{param1}')
    })

    it('avoids param1 collision with existing named param :param1', () => {
      assert.equal(
        normalizeRouteExpress('/users/:param1/*', { param1: 'x' }),
        '/users/{param1}/{param2}'
      )
    })

    it('avoids both param1 and param2 collision', () => {
      assert.equal(
        normalizeRouteExpress('/:param1/:param2/*', { param1: 'x', param2: 'y' }),
        '/{param1}/{param2}/{param3}'
      )
    })

    it('returns null for non-terminal * (suffix segments cannot be safely represented)', () => {
      assert.equal(normalizeRouteExpress('/a/*/b', {}), null)
    })

    it('returns null for non-terminal :name* catch-all', () => {
      assert.equal(normalizeRouteExpress('/a/:rest*/b', {}), null)
    })
  })

  describe('named catch-all params (:name* and :name+)', () => {
    it('normalizes :name* to {name}', () => {
      assert.equal(normalizeRouteExpress('/files/:path*', { path: 'a/b/c' }), '/files/{path}')
    })

    it('normalizes :name+ to {name}', () => {
      assert.equal(normalizeRouteExpress('/files/:path+', { path: 'a/b/c' }), '/files/{path}')
    })
  })

  describe('Express 5 named wildcard (*name)', () => {
    it('normalizes /*splat to /{splat}', () => {
      assert.equal(normalizeRouteExpress('/*splat', { splat: 'anything' }), '/{splat}')
    })

    it('normalizes /prefix/*rest', () => {
      assert.equal(normalizeRouteExpress('/files/*rest', { rest: 'a/b/c' }), '/files/{rest}')
    })

    it('normalizes /app/*splat with mount prefix', () => {
      assert.equal(normalizeRouteExpress('/api/*wild', { wild: 'x/y' }), '/api/{wild}')
    })
  })

  describe('mount-prefixed routes (sub-routers)', () => {
    it('includes mount prefix in normalized route', () => {
      assert.equal(
        normalizeRouteExpress('/app/users/:id', { id: '5' }),
        '/app/users/{id}'
      )
    })

    it('handles deeply nested mount paths', () => {
      assert.equal(
        normalizeRouteExpress('/api/v1/resources/:resourceId/items/:itemId', { resourceId: 'r1', itemId: 'i1' }),
        '/api/v1/resources/{resourceId}/items/{itemId}'
      )
    })
  })

  describe('combined cases', () => {
    it('static prefix + named param + trailing wildcard', () => {
      assert.equal(
        normalizeRouteExpress('/api/:version/files/*', { version: 'v2', 0: 'dir/file.txt' }),
        '/api/{version}/files/{param1}'
      )
    })

    it('Express 5: mixed static + named param + named wildcard', () => {
      assert.equal(
        normalizeRouteExpress('/api/:version/*path', { version: 'v2', path: 'a/b' }),
        '/api/{version}/{path}'
      )
    })

    it('preserves trailing slash with params', () => {
      assert.equal(
        normalizeRouteExpress('/users/:id/', { id: '1' }),
        '/users/{id}/'
      )
    })
  })

  describe('URL-based optional param resolution (mergeParams=false fix)', () => {
    it('resolves present optional param from URL when absent from req.params', () => {
      // app.use('/api/:version?', router) without mergeParams — req.params = {} in sub-handler
      assert.equal(
        normalizeRouteExpress('/api/:version?/users', {}, '/api/v1/users'),
        '/api/{version}/users'
      )
    })

    it('resolves absent optional param from URL', () => {
      assert.equal(
        normalizeRouteExpress('/api/:version?/users', {}, '/api/users'),
        '/api/users'
      )
    })

    it('falls back to params when urlPath is not provided', () => {
      // Without urlPath, empty params → optional treated as absent
      assert.equal(normalizeRouteExpress('/api/:version?/users', {}), '/api/users')
    })

    it('falls back to params when URL does not match route', () => {
      // URL mismatch → extractParamsFromUrl returns null → use req.params
      assert.equal(
        normalizeRouteExpress('/api/:version?/users', { version: 'v2' }, '/completely/different/path'),
        '/api/{version}/users'
      )
    })

    it('resolves multiple optional params from URL — both present', () => {
      assert.equal(
        normalizeRouteExpress('/a/:x?/:y?/b', {}, '/a/1/2/b'),
        '/a/{x}/{y}/b'
      )
    })

    it('resolves multiple optional params from URL — first present only', () => {
      assert.equal(
        normalizeRouteExpress('/a/:x?/:y?/b', {}, '/a/1/b'),
        '/a/{x}/b'
      )
    })

    it('resolves multiple optional params from URL — none present', () => {
      assert.equal(
        normalizeRouteExpress('/a/:x?/:y?/b', {}, '/a/b'),
        '/a/b'
      )
    })

    it('resolves multi-param segment params from URL', () => {
      assert.equal(
        normalizeRouteExpress('/photos/:id.:format', {}, '/photos/1.jpg'),
        '/photos/{id+format}'
      )
    })

    it('urlPath query string is stripped by the caller; urlPath here is clean path', () => {
      // The caller (appsec/index.js) strips ?... before passing urlPath
      assert.equal(
        normalizeRouteExpress('/users/:id?', {}, '/users/42'),
        '/users/{id}'
      )
    })

    it('req.params is still used when no urlPath and optional is present', () => {
      assert.equal(
        normalizeRouteExpress('/users/:id?', { id: '5' }),
        '/users/{id}'
      )
    })

    it('optional + terminal catch-all: URL extraction not short-circuited by length guard', () => {
      // Bug: urlSegs.length (3) > routeSegs.length (2) triggered early null.
      // Fix: length guard is skipped for routes ending in a catch-all.
      assert.equal(
        normalizeRouteExpress('/:id?/:path*', {}, '/x/y/z'),
        '/{id}/{path}'
      )
    })

    it('optional + catch-all: absent optional with URL extraction', () => {
      assert.equal(
        normalizeRouteExpress('/:id?/:path*', {}, '/y/z'),
        '/{id}/{path}'
      )
    })

    it('mutable backtracking: deeper required-param keys cleaned up on greedy failure', () => {
      // Bug: /:a?/:b-:c?/:e/tail on /foo-/bar-c/tail — failed greedy branch left stale
      // c='c' in params, causing /{b+c}/{e}/tail instead of /{b}/{e}/tail.
      assert.equal(
        normalizeRouteExpress('/:a?/:b-:c?/:e/tail', {}, '/foo-/bar-c/tail'),
        '/{b}/{e}/tail'
      )
    })

    it('mutable backtracking: correct result when greedy succeeds first try', () => {
      assert.equal(
        normalizeRouteExpress('/:a?/:b/end', {}, '/x/y/end'),
        '/{a}/{b}/end'
      )
    })
  })

  describe('static segment encoding (UTF-8 correctness)', () => {
    it('encodes multi-byte UTF-8 characters correctly', () => {
      // é (U+00E9) encodes to %C3%A9 in UTF-8, not %E9 (Latin-1)
      assert.equal(normalizeRouteExpress('/path/café', {}), '/path/caf%C3%A9')
    })

    it('encodes characters not in [A-Za-z0-9.-~_] via encodeURIComponent', () => {
      assert.equal(normalizeRouteExpress('/a/b c', {}), '/a/b%20c')
      assert.equal(normalizeRouteExpress('/a/b!c', {}), '/a/b%21c')
    })

    it('encodes 4-byte emoji correctly as UTF-8 (not as two U+FFFD)', () => {
      // 🚀 U+1F680 → %F0%9F%9A%80 (4 UTF-8 bytes), not %EF%BF%BD%EF%BF%BD (two surrogates)
      assert.equal(normalizeRouteExpress('/path/🚀', {}), '/path/%F0%9F%9A%80')
    })
  })

  describe('hasUnsupportedSyntax — {m,n} quantifiers inside inline regex constraints', () => {
    it('does NOT reject route with {m,n} inside :name(regex) constraint', () => {
      // /:id(\d{2}) is a valid Express 4 route; the { is inside a stripped constraint
      assert.equal(normalizeRouteExpress('/:id(\\d{2})', { id: '12' }), '/{id}')
    })

    it('does NOT reject optional param with {m,n} constraint', () => {
      assert.equal(normalizeRouteExpress('/:id(\\d{2})?', { id: '12' }), '/{id}')
      assert.equal(normalizeRouteExpress('/:id(\\d{2})?', {}), '/')
    })

    it('still rejects Express 5 {/:id} optional-group syntax', () => {
      assert.equal(normalizeRouteExpress('/users{/:id}', {}), null)
    })
  })

  describe('prototype property safety (:toString?, :constructor?)', () => {
    it('treats :toString? as absent when not in req.params', () => {
      // req.params = {} — Object.prototype.toString is inherited, not own → absent
      assert.equal(normalizeRouteExpress('/x/:toString?', {}), '/x')
    })

    it('treats :constructor? as absent when not in req.params', () => {
      assert.equal(normalizeRouteExpress('/x/:constructor?', {}), '/x')
    })

    it('treats :toString? as present when explicitly in req.params', () => {
      assert.equal(normalizeRouteExpress('/x/:toString?', { toString: 'val' }), '/x/{toString}')
    })
  })

  describe('URL matching with static-prefix optional params (v:major? pattern)', () => {
    it('emits {major} when URL has a value after the static prefix', () => {
      // URL seg 'v2': getSegmentRegex('v:major?') = /^v([^/]*)$/ → captures '2'
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', {}, '/api/v2/users'),
        '/api/{major}/users'
      )
    })

    it('skips the entire segment when optional is absent (static prefix is dropped)', () => {
      // URL seg 'v': captures '' → param absent; the segment is skipped (omit-rather-than-guess
      // for the static prefix). Both /api/v/users and /api/users produce /api/users.
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', {}, '/api/v/users'),
        '/api/users'
      )
    })

    it('req.params is used when no urlPath for static-prefix optional', () => {
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', { major: '2' }),
        '/api/{major}/users'
      )
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', {}),
        '/api/users'
      )
    })
  })

  describe('constraint with / (Bug 1 fix)', () => {
    it('returns null for constraint containing / — would corrupt route.split("/")', () => {
      assert.equal(normalizeRouteExpress('/:id([^/]+)', { id: 'foo' }), null)
    })

    it('returns null for constraint containing / in optional param', () => {
      assert.equal(normalizeRouteExpress('/:id([^/]+)?', {}), null)
    })

    it('still normalizes constraint without / (e.g. \\d+)', () => {
      assert.equal(normalizeRouteExpress('/:id(\\d+)', { id: '5' }), '/{id}')
    })
  })

  describe('non-terminal catch-all (returns null)', () => {
    it('returns null for non-terminal *name wildcard', () => {
      assert.equal(normalizeRouteExpress('/*splat/edit', {}), null)
    })

    it('returns null for non-terminal unnamed *', () => {
      assert.equal(normalizeRouteExpress('/files/*/meta', {}), null)
    })

    it('still normalizes terminal named wildcard', () => {
      assert.equal(normalizeRouteExpress('/files/*splat', { splat: 'a/b' }), '/files/{splat}')
    })

    it('still normalizes terminal unnamed *', () => {
      assert.equal(normalizeRouteExpress('/files/*', {}), '/files/{param1}')
    })
  })

  describe('constraint-aware URL matching (fixes req.params override bug)', () => {
    it('correctly assigns b when a has a non-matching \\d+ constraint', () => {
      // Route /:a(\\d+)?/:b? on URL /foo: Express sets b='foo' (a has \\d+ constraint)
      // URL extraction must respect the constraint — not assign a='foo'
      assert.equal(
        normalizeRouteExpress('/:a(\\d+)?/:b?', {}, '/foo'),
        '/{b}'
      )
    })

    it('correctly assigns a when URL matches the \\d+ constraint', () => {
      assert.equal(
        normalizeRouteExpress('/:a(\\d+)?/:b?', {}, '/5'),
        '/{a}'
      )
    })

    it('assigns both when URL has two segments', () => {
      assert.equal(
        normalizeRouteExpress('/:a(\\d+)?/:b?', {}, '/5/foo'),
        '/{a}/{b}'
      )
    })
  })

  describe(':name+ requires at least one URL segment', () => {
    it('normalizes :name+ to {name} when segments present', () => {
      assert.equal(normalizeRouteExpress('/files/:path+', { path: 'a/b' }), '/files/{path}')
    })

    it('normalizes :name* to {name} (zero or more)', () => {
      assert.equal(normalizeRouteExpress('/files/:path*', { path: 'a/b' }), '/files/{path}')
    })
  })
})
