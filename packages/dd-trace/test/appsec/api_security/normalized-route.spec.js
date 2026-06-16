'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const {
  normalizeRouteExpress,
  normalizeRoute,
  parseRoute,
  compileRoute,
} = require('../../../src/appsec/api_security/normalized-route')

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

    it('returns null for unterminated quoted param name', () => {
      assert.equal(normalizeRouteExpress('/users/:"unterminated', {}), null)
    })

    it('returns null for unbalanced optional group brace', () => {
      assert.equal(normalizeRouteExpress('/users{/:id', {}), null)
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

    it('collapses empty (consecutive-slash) segments (rule 2)', () => {
      assert.equal(normalizeRouteExpress('/a//b', {}, '/a/b'), '/a/b')
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
  })

  describe('Express 5 {/:param} optional-group syntax', () => {
    it('normalizes {/:id} — param present via URL extraction', () => {
      assert.equal(normalizeRouteExpress('/items{/:id}', {}, '/items/42'), '/items/{id}')
    })

    it('normalizes {/:id} — param absent via URL extraction', () => {
      assert.equal(normalizeRouteExpress('/items{/:id}', {}, '/items'), '/items')
    })

    it('normalizes {/:id} with param in req.params', () => {
      assert.equal(normalizeRouteExpress('/items{/:id}', { id: '42' }), '/items/{id}')
    })

    it('normalizes middle optional segment {/:version}', () => {
      assert.equal(normalizeRouteExpress('/api{/:version}/users', {}, '/api/v1/users'), '/api/{version}/users')
      assert.equal(normalizeRouteExpress('/api{/:version}/users', {}, '/api/users'), '/api/users')
    })

    it('normalizes {.:format} extension optional in same segment', () => {
      assert.equal(normalizeRouteExpress('/photos/:id{.:format}', { id: '1', format: 'jpg' }), '/photos/{id+format}')
      assert.equal(normalizeRouteExpress('/photos/:id{.:format}', { id: '1' }), '/photos/{id}')
    })

    it('normalizes {/:id.:format} multi-param optional segment', () => {
      assert.equal(normalizeRouteExpress('/posts{/:id.:format}', {}, '/posts/1.json'), '/posts/{id+format}')
      assert.equal(normalizeRouteExpress('/posts{/:id.:format}', {}, '/posts'), '/posts')
    })

    it('resolves optional static group {/draft} — present', () => {
      assert.equal(normalizeRouteExpress('/posts{/draft}', {}, '/posts/draft'), '/posts/draft')
    })

    it('resolves optional static group {/draft} — absent', () => {
      assert.equal(normalizeRouteExpress('/posts{/draft}', {}, '/posts'), '/posts')
    })

    it('optional static group is absent when no URL is available (cannot infer from params)', () => {
      assert.equal(normalizeRouteExpress('/posts{/draft}', {}), '/posts')
    })

    it('resolves optional catch-all group {/*path} — present', () => {
      assert.equal(normalizeRouteExpress('/files{/*path}', {}, '/files/a/b'), '/files/{path}')
    })

    it('resolves optional catch-all group {/*path} — absent', () => {
      assert.equal(normalizeRouteExpress('/files{/*path}', {}, '/files'), '/files')
    })

    it('resolves quoted param name {/:"user-id"} (hyphen allowed in name)', () => {
      assert.equal(normalizeRouteExpress('/users{/:"user-id"}', {}, '/users/42'), '/users/{user-id}')
      assert.equal(normalizeRouteExpress('/users{/:"user-id"}', {}, '/users'), '/users')
    })

    it('resolves nested optional groups {/:b{/:c}}', () => {
      assert.equal(normalizeRouteExpress('/a{/:b{/:c}}', {}, '/a/x/y'), '/a/{b}/{c}')
      assert.equal(normalizeRouteExpress('/a{/:b{/:c}}', {}, '/a/x'), '/a/{b}')
      assert.equal(normalizeRouteExpress('/a{/:b{/:c}}', {}, '/a'), '/a')
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
    // A non-delimiter static prefix ('v') is mandatory; only ':major' is optional. path-to-regexp
    // treats just a delimiter char ('/', '.') as part of the optional prefix, not arbitrary text.
    it('emits {major} when the param has a value after the static prefix', () => {
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', {}, '/api/v2/users'),
        '/api/{major}/users'
      )
    })

    it('keeps the mandatory static prefix when the optional param is absent', () => {
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', {}, '/api/v/users'),
        '/api/v/users'
      )
    })

    it('req.params is used when no urlPath for static-prefix optional', () => {
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', { major: '2' }),
        '/api/{major}/users'
      )
      assert.equal(
        normalizeRouteExpress('/api/v:major?/users', {}),
        '/api/v/users'
      )
    })
  })

  describe('inline constraints (Express 4) — name extracted, constraint ignored', () => {
    it('normalizes a constraint containing / (e.g. [^/]+) — Express 4 only', () => {
      assert.equal(normalizeRouteExpress('/:id([^/]+)', { id: 'foo' }, '/foo'), '/{id}')
    })

    it('normalizes an optional param with a / in its constraint', () => {
      assert.equal(normalizeRouteExpress('/:id([^/]+)?', { id: 'x' }, '/x'), '/{id}')
      assert.equal(normalizeRouteExpress('/:id([^/]+)?', {}, '/'), '/')
    })

    it('normalizes constraint without / (e.g. \\d+)', () => {
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

  describe('constraint disambiguation via req.params (authority for optional presence)', () => {
    // Developer inline constraints are no longer embedded in the URL matcher (ReDoS safety), so
    // adjacent optional params are disambiguated by req.params — exactly what Express populates.
    it('assigns b when Express matched b (a has a non-matching \\d+ constraint)', () => {
      assert.equal(
        normalizeRouteExpress('/:a(\\d+)?/:b?', { b: 'foo' }, '/foo'),
        '/{b}'
      )
    })

    it('assigns a when Express matched a (value satisfies the \\d+ constraint)', () => {
      assert.equal(
        normalizeRouteExpress('/:a(\\d+)?/:b?', { a: '5' }, '/5'),
        '/{a}'
      )
    })

    it('assigns both when both params are present', () => {
      assert.equal(
        normalizeRouteExpress('/:a(\\d+)?/:b?', { a: '5', b: 'foo' }, '/5/foo'),
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

  describe('optional param with trailing static suffix', () => {
    it('optional param with trailing static suffix — present via URL extraction', () => {
      // Segment ':id?.html' has static '.html' after the param — exercises trailing-static branch
      assert.equal(
        normalizeRouteExpress('/items/:id?.html', {}, '/items/photo.html'),
        '/items/{id}'
      )
    })

    it('optional param with trailing static suffix — absent via URL extraction', () => {
      assert.equal(
        normalizeRouteExpress('/items/:id?.html', {}, '/items'),
        '/items'
      )
    })
  })

  describe('invalid constraint regex falls back to generic matching', () => {
    it('falls back to generic matching when constraint is not a valid regex', () => {
      // ':id([invalid)?' — constraint '[invalid' is an unclosed bracket, invalid regex.
      // hasUnsupportedSyntax strips the constraint cleanly so the route is not rejected,
      // but getSegmentRegex throws on new RegExp and falls back to buildGenericSegmentRegex.
      assert.equal(
        normalizeRouteExpress('/:id([invalid)?/users', {}, '/foo/users'),
        '/{id}/users'
      )
    })

    it('fallback: absent optional with invalid constraint', () => {
      assert.equal(
        normalizeRouteExpress('/:id([invalid)?/users', {}, '/users'),
        '/users'
      )
    })

    it('fallback: leading static prefix before param with invalid constraint (line 202)', () => {
      // 'v:id([invalid)?' has static 'v' before the param — exercises the leading-static branch
      assert.equal(
        normalizeRouteExpress('/v:id([invalid)?/users', {}, '/v5/users'),
        '/{id}/users'
      )
    })

    it('fallback: trailing static suffix after param with invalid constraint (line 208)', () => {
      // ':id([invalid)?.html' has static '.html' after the param — exercises trailing-static branch
      assert.equal(
        normalizeRouteExpress('/:id([invalid)?.html/users', {}, '/photo.html/users'),
        '/{id}/users'
      )
    })
  })

  describe('named wildcard (*name) capture via URL extraction', () => {
    it('captures named wildcard value when optional precedes it and is present', () => {
      // /:id?/*rest — exercises the namedWildcard terminal branch in matchSegs
      assert.equal(
        normalizeRouteExpress('/:id?/*rest', {}, '/x/y/z'),
        '/{id}/{rest}'
      )
    })

    it('captures named wildcard value when optional is absent', () => {
      assert.equal(
        normalizeRouteExpress('/:id?/*rest', {}, '/y/z'),
        '/{id}/{rest}'
      )
    })
  })

  describe('duplicate param names (shadowed occurrences become paramN)', () => {
    it('keeps the name on the last occurrence; earlier one becomes param1', () => {
      // Express keeps only the last value in req.params for a duplicated name, so earlier
      // occurrences have no retrievable name and are treated as nameless (RFC rule 4).
      assert.equal(normalizeRouteExpress('/:id/:id', {}, '/x/y'), '/{param1}/{id}')
    })

    it('numbers multiple shadowed occurrences in declaration order', () => {
      assert.equal(normalizeRouteExpress('/:id/:id/:id', {}, '/x/y/z'), '/{param1}/{param2}/{id}')
    })

    it('skips paramN that collides with a surviving framework name', () => {
      assert.equal(normalizeRouteExpress('/:param1/:param1', {}, '/x/y'), '/{param2}/{param1}')
    })
  })

  describe('normalizeRoute(req) dispatcher', () => {
    // The dispatcher reads the component/route via the web module; the express path is covered
    // end-to-end by the express plugin integration spec. Here we assert the short-circuit when
    // there is no active web span (web.root(req) is undefined → component undefined → null).
    it('returns null when there is no active web span', () => {
      assert.equal(normalizeRoute({ originalUrl: '/x', params: {} }), null)
    })
  })

  describe('parseRoute (tokenizer)', () => {
    it('parses a simple param route into tokens', () => {
      const parsed = parseRoute('/users/:id')
      assert.ok(parsed)
      const types = parsed.tokens.map(t => t.type)
      assert.deepEqual(types, ['slash', 'static', 'slash', 'param'])
      assert.equal(parsed.tokens[3].name, 'id')
    })

    it('returns null for standalone parentheses', () => {
      assert.equal(parseRoute('/path(\\.ext)?'), null)
    })

    it('returns null for unbalanced braces', () => {
      assert.equal(parseRoute('/a{/:b'), null)
    })

    it('records optional group nesting in groupParent', () => {
      const parsed = parseRoute('/a{/:b{/:c}}')
      assert.ok(parsed)
      // two brace groups: inner (2) nested under outer (1) which is top-level (0)
      assert.equal(parsed.groupParent.get(1), 0)
      assert.equal(parsed.groupParent.get(2), 1)
    })
  })

  describe('compileRoute', () => {
    it('precomputes the result for a route with no optional groups', () => {
      const compiled = compileRoute('/users/:id')
      assert.equal(compiled.precomputed, '/users/{id}')
      assert.equal(compiled.optionalGroups.length, 0)
    })

    it('returns an entry with optional groups (no precomputed value) for optional routes', () => {
      const compiled = compileRoute('/users/:id?')
      assert.equal(compiled.precomputed, null)
      assert.ok(compiled.optionalGroups.length > 0)
    })

    it('returns null for unsupported routes', () => {
      assert.equal(compileRoute('/path(\\.ext)?'), null)
    })

    it('compiles the root route to "/"', () => {
      assert.equal(compileRoute('/').precomputed, '/')
    })
  })

  describe('review-finding regressions', () => {
    it('capturing group inside an inline constraint does not corrupt optional detection', () => {
      // The (o) capture inside the constraint must not shift the optional-group presence marker.
      assert.equal(normalizeRouteExpress('/:id(fo(o)).:format?', {}, '/foo'), '/{id}')
      assert.equal(normalizeRouteExpress('/:id(fo(o)).:format?', {}, '/foo.json'), '/{id+format}')
    })

    it('combines a named param with a catch-all in the same segment', () => {
      assert.equal(normalizeRouteExpress('/x/:a-*', {}, '/x/y-z/w'), '/x/{a+param1}')
    })

    it('enforces name uniqueness on encoded names (no post-encode collision)', () => {
      // ':"a/b"' and ':"a%2Fb"' both encode to a%2Fb → first must be shadowed to paramN.
      assert.equal(normalizeRouteExpress('/:"a/b"/:"a%2Fb"', {}, '/x/y'), '/{param1}/{a%2Fb}')
    })

    it('treats backslash-escaped reserved chars as static (Express 5)', () => {
      assert.equal(normalizeRouteExpress('/file/\\{id\\}', {}, '/file/{id}'), '/file/%7Bid%7D')
      assert.equal(normalizeRouteExpress('/foo/\\(bar\\)', {}, '/foo/(bar)'), '/foo/%28bar%29')
    })

    it('returns null for a non-terminal param whose constraint can consume "/"', () => {
      assert.equal(normalizeRouteExpress('/:id(.+)/tail', { id: 'a/b' }, '/a/b/tail'), null)
    })

    it('allows a terminal param whose constraint can consume "/"', () => {
      assert.equal(normalizeRouteExpress('/files/:id(.+)', { id: 'a/b' }, '/files/a/b'), '/files/{id}')
    })

    it('returns null when a route has too many optional groups (bitmask/backtracking guard)', () => {
      const route = '/r' + Array.from({ length: 33 }, (_, i) => `{/s${i + 1}}`).join('')
      assert.equal(normalizeRouteExpress(route, {}, '/r/s33'), null)
    })

    it('does not blow up on many optional params against a non-matching URL', () => {
      const route = '/' + Array.from({ length: 12 }, (_, i) => `:p${i}?`).join('/') + '/zzz'
      const url = '/' + Array.from({ length: 12 }, () => 'x').join('/') + '/nomatch'
      const start = process.hrtime.bigint()
      normalizeRouteExpress(route, {}, url) // must return quickly (step-budget bounded)
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      assert.ok(ms < 100, `expected < 100ms, got ${ms.toFixed(1)}ms`)
    })
  })

  describe('review-finding regressions (round 3)', () => {
    it('does not stall on a catastrophic-backtracking inline constraint (ReDoS)', () => {
      // The constraint is NOT embedded in the URL matcher (generic [^/]+? used instead).
      const url = '/' + 'a'.repeat(60) + '!/x'
      const start = process.hrtime.bigint()
      normalizeRouteExpress('/:id((a+)+$)?/x', {}, url)
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      assert.ok(ms < 50, `expected < 50ms, got ${ms.toFixed(1)}ms`)
    })

    it('keeps a non-delimiter static prefix on an absent optional param', () => {
      assert.equal(normalizeRouteExpress('/x:id?', {}, '/x'), '/x')
      assert.equal(normalizeRouteExpress('/x:id?', {}, '/x5'), '/{id}')
      assert.equal(normalizeRouteExpress('/foo/v:id?', {}, '/foo/v'), '/foo/v')
    })

    it('rejects a non-terminal param whose constraint contains a literal "/"', () => {
      assert.equal(normalizeRouteExpress('/:id(foo/bar)/tail', {}, '/foo/bar/tail'), null)
    })

    it('matches a non-ASCII static optional against the percent-encoded URL', () => {
      assert.equal(normalizeRouteExpress('/posts{/café}', {}, '/posts/caf%C3%A9'), '/posts/caf%C3%A9')
      assert.equal(normalizeRouteExpress('/posts{/café}', {}, '/posts'), '/posts')
    })

    it('supports $ and Unicode characters in param names', () => {
      assert.equal(normalizeRouteExpress('/:$foo', { $foo: 'x' }, '/x'), '/{$foo}')
      assert.equal(normalizeRouteExpress('/:café', { café: 'x' }, '/x'), '/{café}')
    })

    it('handles escaped quotes inside a quoted param name (" is allowed unencoded per rule 4)', () => {
      assert.equal(normalizeRouteExpress('/:"a\\"b"', { 'a"b': 'x' }, '/x'), '/{a"b}')
    })

    it('a constraint containing our marker group name does not corrupt detection', () => {
      assert.equal(normalizeRouteExpress('/:id((?<_ddg1>foo)){.:format}', {}, '/foo.json'), '/{id+format}')
    })

    it('returns a string or null (never throws/stalls) on a pathological no-match', () => {
      const route = '/' + Array.from({ length: 12 }, (_, i) => `:p${i}?`).join('/') + '/zzz'
      const url = '/' + Array.from({ length: 12 }, () => 'x').join('/') + '/nomatch'
      const result = normalizeRouteExpress(route, {}, url)
      assert.ok(result === null || typeof result === 'string')
    })
  })

  describe('review-finding regressions (round 4)', () => {
    it('does not stall on sequential-quantifier constraints (ReDoS class 2)', () => {
      const url = '/' + 'a'.repeat(60) + '!/x'
      const start = process.hrtime.bigint()
      normalizeRouteExpress('/:id(a*a*a*a*a*a*a*a*a*a*$)?/x', {}, url)
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      assert.ok(ms < 50, `expected < 50ms, got ${ms.toFixed(1)}ms`)
    })

    it('disambiguates adjacent optionals from req.params, not the URL', () => {
      // req.params is authoritative: a constrained param Express did not match stays absent.
      assert.equal(normalizeRouteExpress('/:a(\\d+)?/:b?', { b: 'foo' }, '/foo'), '/{b}')
    })

    it('matches static segments case-insensitively (Express default) but preserves declared case', () => {
      assert.equal(normalizeRouteExpress('/api/:version?/Users', {}, '/api/v1/users'), '/api/{version}/Users')
    })

    it('treats a terminal slash-consuming constraint as a catch-all (recovers parent param)', () => {
      assert.equal(
        normalizeRouteExpress('/api/:version?/files/:rest(.+)', {}, '/api/v1/files/a/b'),
        '/api/{version}/files/{rest}'
      )
    })

    it('matches a wildcard segment prefix before consuming the rest', () => {
      // ':a-' prefix must match; on /y-z/w the :id? is correctly absent (Express: id undefined).
      assert.equal(normalizeRouteExpress('/:id?/:a-*', {}, '/y-z/w'), '/{a+param1}')
    })

    describe('Express 4 dialect (isV5=false)', () => {
      it('treats braces as literal static, not optional groups', () => {
        assert.equal(normalizeRouteExpress('/file/{id}', {}, '/file/{id}', false), '/file/%7Bid%7D')
      })

      it('rejects bare string-pattern regex characters', () => {
        assert.equal(normalizeRouteExpress('/ab?cd', {}, '/acd', false), null)
        assert.equal(normalizeRouteExpress('/ab+cd', {}, '/abbcd', false), null)
      })

      it('treats * as an unnamed wildcard', () => {
        assert.equal(normalizeRouteExpress('/files/*', { 0: 'a/b' }, '/files/a/b', false), '/files/{param1}')
      })

      it('still normalizes ordinary v4 params and optionals', () => {
        assert.equal(normalizeRouteExpress('/users/:id', { id: '1' }, '/users/1', false), '/users/{id}')
        assert.equal(normalizeRouteExpress('/users/:id?', {}, '/users', false), '/users')
      })
    })

    describe('Express 5 dialect (default) keeps brace/quoted/named-wildcard syntax', () => {
      it('parses {/:id} optional group', () => {
        assert.equal(normalizeRouteExpress('/items{/:id}', {}, '/items/42', true), '/items/{id}')
      })

      it('parses *name named wildcard', () => {
        assert.equal(normalizeRouteExpress('/files/*splat', { splat: 'a/b' }, '/files/a/b', true), '/files/{splat}')
      })

      it('rejects v4-only quoted names and char-class string-patterns', () => {
        assert.equal(normalizeRouteExpress('/:"user-id"', {}, '/x', false), null)
        assert.equal(normalizeRouteExpress('/ab[cd]e', {}, '/abce', false), null)
      })
    })
  })

  describe('review-finding regressions (round 5)', () => {
    it('URL is authoritative: recovers a mergeParams-dropped parent optional param', () => {
      // req.params only has the child's id (parent version dropped by mergeParams=false), but the
      // URL shows version present — must not be dropped.
      assert.equal(
        normalizeRouteExpress('/api/:version?/users/:id?', { id: '42' }, '/api/v1/users/42', false),
        '/api/{version}/users/{id}'
      )
    })

    it('does not mark an absent optional present when a name is shared across groups', () => {
      assert.equal(normalizeRouteExpress('/:id{/:id}', { id: 'x' }, '/x', true), '/{id}')
      assert.equal(normalizeRouteExpress('/a{/:x}/b{/:x}', { x: 'v' }, '/a/b/v', true), '/a/b/{x}')
    })

    it('req.params only biases ordering; empty params keeps Express greedy (first optional wins)', () => {
      assert.equal(normalizeRouteExpress('/a/:x?/:y?/b', {}, '/a/1/b', true), '/a/{x}/b')
    })

    it('biases to the param Express actually set for adjacent constrained optionals', () => {
      assert.equal(normalizeRouteExpress('/:a(\\d+)?/:b?', { b: 'foo' }, '/foo', true), '/{b}')
      assert.equal(normalizeRouteExpress('/:a(\\d+)?/:b?', { a: '5' }, '/5', true), '/{a}')
    })

    it('accepts an escaped paren inside a v4 inline constraint', () => {
      assert.equal(normalizeRouteExpress('/:id(foo\\))', { id: 'foo)' }, '/foo)', false), '/{id}')
    })
  })

  describe('review-finding regressions (round 6)', () => {
    it('a constraint with "/" only inside a character class is single-segment (not a catch-all)', () => {
      // [^/]+ contains a slash but denies it → a normal single-segment param, not slash-spanning.
      assert.equal(normalizeRouteExpress('/:id([^/]+)/users', { id: 'foo' }, '/foo/users', false), '/{id}/users')
      assert.equal(normalizeRouteExpress('/:id([^/]+)?/users', { id: 'x' }, '/x/users', false), '/{id}/users')
      assert.equal(normalizeRouteExpress('/:id([^/]+)?/users', {}, '/users', false), '/users')
    })

    it('still rejects a constraint that genuinely contains a literal "/" (non-terminal)', () => {
      assert.equal(normalizeRouteExpress('/:id(foo/bar)/tail', {}, '/foo/bar/tail', false), null)
    })

    it('returns null for a non-terminal catch-all (cannot be represented)', () => {
      assert.equal(normalizeRouteExpress('/x{/*rest}/tail', {}, '/x/a/tail', true), null)
      assert.equal(normalizeRouteExpress('/a/*splat/b', {}, '/a/x/b', true), null)
    })

    it('still normalizes a terminal optional catch-all', () => {
      assert.equal(normalizeRouteExpress('/files{/*path}', {}, '/files/a/b', true), '/files/{path}')
      assert.equal(normalizeRouteExpress('/files{/*path}', {}, '/files', true), '/files')
    })

    it('returns null when a segment has two independent optional groups', () => {
      assert.equal(normalizeRouteExpress('/:a{.:b}{-:c}', { a: 'x', b: 'z' }, '/x.z', true), null)
    })

    it('still normalizes a single intra-segment optional group', () => {
      assert.equal(
        normalizeRouteExpress('/photos/:id{.:format}', { id: '1', format: 'jpg' }, '/photos/1.jpg', true),
        '/photos/{id+format}'
      )
    })

    it('collapses structural-only (empty) nested optional groups', () => {
      assert.equal(normalizeRouteExpress('/a{{/b}}', {}, '/a/b', true), '/a/b')
      assert.equal(normalizeRouteExpress('/a{{/b}}', {}, '/a', true), '/a')
    })

    it('still resolves genuinely nested optional params', () => {
      assert.equal(normalizeRouteExpress('/a{/:b{/:c}}', {}, '/a/x/y', true), '/a/{b}/{c}')
      assert.equal(normalizeRouteExpress('/a{/:b{/:c}}', {}, '/a/x', true), '/a/{b}')
    })
  })
})
