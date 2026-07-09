'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
// path-to-regexp is a transitive (vendored) dependency, not a declared one; requiring it directly
// lets these unit tests exercise the normalizer against the real Express 5 (v8) parser output.
// eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require
const { parse: rawParse } = require('path-to-regexp')
const {
  normalizeRouteExpress,
  normalizeRoute,
} = require('../../../src/appsec/api_security/normalized-route')

// Mirror the contract of the path-to-regexp instrumentation adapter (getParse): return the v8
// TokenData ({ tokens }) or undefined when the parser throws / the shape is unexpected. Express 5
// ships path-to-regexp v8, which is what this normalizer targets.
function parse (pattern) {
  let result
  try {
    result = rawParse(pattern)
  } catch {
    return undefined
  }
  return Array.isArray(result?.tokens) ? result : undefined
}

// Convenience wrapper: inject the Express 5 parser as the 4th argument.
function normalize (route, params, urlPath) {
  return normalizeRouteExpress(route, params, urlPath, parse)
}

describe('normalizeRouteExpress', () => {
  describe('invalid / unsupported inputs', () => {
    it('returns null for null', () => {
      assert.equal(normalize(null, {}), null)
    })

    it('returns null for undefined', () => {
      assert.equal(normalize(undefined, {}), null)
    })

    it('returns null for empty string', () => {
      assert.equal(normalize('', {}), null)
    })

    it('returns null for non-string', () => {
      assert.equal(normalize(42, {}), null)
    })

    it('returns null when no parse function is provided (Express 4 / path-to-regexp 0.x)', () => {
      assert.equal(normalizeRouteExpress('/users/:id', {}, '/users/1', undefined), null)
    })

    it('returns null for unterminated quoted param name (parser throws)', () => {
      assert.equal(normalize('/users/:"unterminated', {}), null)
    })

    it('returns null for unbalanced optional group brace (parser throws)', () => {
      assert.equal(normalize('/users{/:id', {}), null)
    })

    it('returns null for standalone parentheses (parser throws)', () => {
      assert.equal(normalize('/path(\\.ext)?', {}), null)
    })
  })

  describe('Express 4 syntax is unsupported (parser throws → null)', () => {
    // path-to-regexp v8 (Express 5) rejects the Express 4 grammar. A real Express 5 app cannot
    // register these routes, so omitting the tag is correct.
    it('returns null for :id? optional-suffix param', () => {
      assert.equal(normalize('/users/:id?', {}), null)
    })

    it('returns null for inline regex constraint :id(\\d+)', () => {
      assert.equal(normalize('/users/:id(\\d+)', { id: '5' }), null)
    })

    it('returns null for unnamed wildcard *', () => {
      assert.equal(normalize('/files/*', {}), null)
    })

    it('returns null for :name* / :name+ modifiers', () => {
      assert.equal(normalize('/files/:path*', {}), null)
      assert.equal(normalize('/files/:path+', {}), null)
    })

    it('returns null for a static-prefixed optional param v:major?', () => {
      assert.equal(normalize('/api/v:major?/users', {}), null)
    })
  })

  describe('root and trivial routes', () => {
    it('returns "/" for root route', () => {
      assert.equal(normalize('/', {}), '/')
    })

    it('preserves trailing slash when declared', () => {
      assert.equal(normalize('/users/', {}), '/users/')
    })

    it('does not add trailing slash when not declared', () => {
      assert.equal(normalize('/users', {}), '/users')
    })

    it('collapses empty (consecutive-slash) segments (rule 2)', () => {
      assert.equal(normalize('/a//b', {}, '/a/b'), '/a/b')
    })
  })

  describe('static routes', () => {
    it('preserves plain ASCII static segments', () => {
      assert.equal(normalize('/api/v1/users', {}), '/api/v1/users')
    })

    it('preserves dots and dashes in static segments', () => {
      assert.equal(normalize('/api/v2.0/some-path', {}), '/api/v2.0/some-path')
    })

    it('URL-encodes characters outside the allowed static set', () => {
      assert.equal(normalize('/api/hello world', {}), '/api/hello%20world')
    })

    it('URL-encodes special chars in static segments', () => {
      assert.equal(normalize('/path/foo@bar', {}), '/path/foo%40bar')
    })
  })

  describe('required named params', () => {
    it('normalizes a single required param', () => {
      assert.equal(normalize('/users/:id', { id: '123' }), '/users/{id}')
    })

    it('normalizes multiple required params in separate segments', () => {
      assert.equal(
        normalize('/users/:userId/posts/:postId', { userId: '1', postId: '2' }),
        '/users/{userId}/posts/{postId}'
      )
    })

    it('normalizes static and dynamic segments mixed', () => {
      assert.equal(normalize('/api/v1/users/:id', { id: '42' }), '/api/v1/users/{id}')
    })

    it('works when params is null (required params still included)', () => {
      assert.equal(normalize('/users/:id', null), '/users/{id}')
    })

    it('supports $ and Unicode characters in param names', () => {
      assert.equal(normalize('/:$foo', { $foo: 'x' }, '/x'), '/{$foo}')
      assert.equal(normalize('/:café', { café: 'x' }, '/x'), '/{café}')
    })
  })

  describe('multi-param segments (rule 5)', () => {
    it('combines two required params in one segment with "+"', () => {
      assert.equal(
        normalize('/photos/:id.:format', { id: '1', format: 'jpg' }),
        '/photos/{id+format}'
      )
    })

    it('combines three params in one segment', () => {
      assert.equal(
        normalize('/v/:major.:minor.:patch', { major: '1', minor: '2', patch: '3' }),
        '/v/{major+minor+patch}'
      )
    })

    it('single param with surrounding static text becomes just the param (rule 5)', () => {
      assert.equal(normalize('/users/user-:id', { id: '5' }), '/users/{id}')
    })
  })

  describe('Express 5 named wildcard (*name)', () => {
    it('normalizes /*splat to /{splat}', () => {
      assert.equal(normalize('/*splat', { splat: 'anything' }), '/{splat}')
    })

    it('normalizes /prefix/*rest', () => {
      assert.equal(normalize('/files/*rest', { rest: 'a/b/c' }), '/files/{rest}')
    })

    it('avoids paramN collision with existing named params', () => {
      assert.equal(normalize('/:param1/:param2/*', { param1: 'x', param2: 'y' }), null) // unnamed * throws
      assert.equal(
        normalize('/:param1/:param2/*rest', { param1: 'x', param2: 'y', rest: 'z' }),
        '/{param1}/{param2}/{rest}'
      )
    })
  })

  describe('non-terminal catch-all (returns null)', () => {
    it('returns null for non-terminal *name wildcard', () => {
      assert.equal(normalize('/*splat/edit', {}), null)
    })

    it('returns null for a non-terminal optional catch-all group', () => {
      assert.equal(normalize('/x{/*rest}/tail', {}, '/x/a/tail'), null)
    })
  })

  describe('wildcard with a prefix in its segment', () => {
    it('normalizes a prefixed wildcard when the route has no optional groups (precomputed)', () => {
      assert.equal(normalize('/files/v*rest', {}, '/files/vY/z'), '/files/{rest}')
      assert.equal(normalize('/x/:a-*rest', {}, '/x/y-z/w'), '/x/{a+rest}')
    })

    it('rejects a prefixed wildcard once the route also has an optional group', () => {
      // A prefixed wildcard can't be presence-resolved consistently with path-to-regexp when the
      // backtracking matcher runs (which optional groups require), so we omit the tag.
      assert.equal(normalize('/files{/:opt}/v*rest', {}, '/files/x/vY/z'), null)
      assert.equal(normalize('/a{/:id}/p{q}*rest', {}, '/a/1/pZ/w'), null)
    })
  })

  describe('mount-prefixed routes (sub-routers)', () => {
    it('includes mount prefix in normalized route', () => {
      assert.equal(normalize('/app/users/:id', { id: '5' }), '/app/users/{id}')
    })
  })

  describe('combined cases', () => {
    it('Express 5: mixed static + named param + named wildcard', () => {
      assert.equal(
        normalize('/api/:version/*path', { version: 'v2', path: 'a/b' }),
        '/api/{version}/{path}'
      )
    })

    it('preserves trailing slash with params', () => {
      assert.equal(normalize('/users/:id/', { id: '1' }), '/users/{id}/')
    })
  })

  describe('Express 5 {/:param} optional-group syntax', () => {
    it('normalizes {/:id} — param present via URL extraction', () => {
      assert.equal(normalize('/items{/:id}', {}, '/items/42'), '/items/{id}')
    })

    it('normalizes {/:id} — param absent via URL extraction', () => {
      assert.equal(normalize('/items{/:id}', {}, '/items'), '/items')
    })

    it('normalizes {/:id} with param in req.params', () => {
      assert.equal(normalize('/items{/:id}', { id: '42' }), '/items/{id}')
    })

    it('normalizes middle optional segment {/:version}', () => {
      assert.equal(normalize('/api{/:version}/users', {}, '/api/v1/users'), '/api/{version}/users')
      assert.equal(normalize('/api{/:version}/users', {}, '/api/users'), '/api/users')
    })

    it('normalizes {/:id.:format} multi-param optional segment', () => {
      assert.equal(normalize('/posts{/:id.:format}', {}, '/posts/1.json'), '/posts/{id+format}')
      assert.equal(normalize('/posts{/:id.:format}', {}, '/posts'), '/posts')
    })

    it('resolves optional static group {/draft} — present', () => {
      assert.equal(normalize('/posts{/draft}', {}, '/posts/draft'), '/posts/draft')
    })

    it('resolves optional static group {/draft} — absent', () => {
      assert.equal(normalize('/posts{/draft}', {}, '/posts'), '/posts')
    })

    it('optional static group is absent when no URL is available (cannot infer from params)', () => {
      assert.equal(normalize('/posts{/draft}', {}), '/posts')
    })

    it('resolves optional catch-all group {/*path} — present', () => {
      assert.equal(normalize('/files{/*path}', {}, '/files/a/b'), '/files/{path}')
    })

    it('resolves optional catch-all group {/*path} — absent', () => {
      assert.equal(normalize('/files{/*path}', {}, '/files'), '/files')
    })

    it('resolves quoted param name {/:"user-id"} (hyphen allowed in name)', () => {
      assert.equal(normalize('/users{/:"user-id"}', {}, '/users/42'), '/users/{user-id}')
      assert.equal(normalize('/users{/:"user-id"}', {}, '/users'), '/users')
    })

    it('resolves nested optional groups {/:b{/:c}}', () => {
      assert.equal(normalize('/a{/:b{/:c}}', {}, '/a/x/y'), '/a/{b}/{c}')
      assert.equal(normalize('/a{/:b{/:c}}', {}, '/a/x'), '/a/{b}')
      assert.equal(normalize('/a{/:b{/:c}}', {}, '/a'), '/a')
    })

    it('collapses structural-only (empty) nested optional groups', () => {
      assert.equal(normalize('/a{{/b}}', {}, '/a/b'), '/a/b')
      assert.equal(normalize('/a{{/b}}', {}, '/a'), '/a')
    })
  })

  describe('un-representable single-segment shapes (returns null, not a wrong tag)', () => {
    // A param/wildcard inside an intra-segment optional group needs path-to-regexp's delimiter-aware
    // matching to resolve presence; our generic '[^/]+?' matcher can't, so we omit the tag rather
    // than emit a wrong combination.
    it('rejects a param inside an intra-segment optional group', () => {
      // path-to-regexp matches '/photos/1..' as { id: '1..' } (format absent) → we would mis-assign.
      assert.equal(normalize('/photos/:id{.:format}', {}, '/photos/1.jpg'), null)
      assert.equal(normalize('/:a{-:b}', {}, '/x--'), null)
      assert.equal(normalize('/:a{.:b}c', {}, '/x.yc'), null)
    })

    it('rejects two independent, and nested, optional groups in one segment', () => {
      assert.equal(normalize('/:a{.:b}{-:c}', {}, '/x.y-z'), null)
      assert.equal(normalize('/:a{.:b{.:c}-:d}', {}, '/x.y-z'), null)
    })

    it('rejects an optional group before a wildcard in the same segment', () => {
      assert.equal(normalize('/:a{.:b}-*rest', {}, '/x.y-/def'), null)
    })

    it('rejects a wildcard with suffix tokens in its segment (non-terminal catch-all)', () => {
      assert.equal(normalize('/files/*path.:ext', {}, '/files/a/b.txt'), null)
      assert.equal(normalize('/*a-*b', {}, '/x-y'), null)
    })

    it('rejects an optional group that spans more than one URL segment', () => {
      // A group is atomic in path-to-regexp; an adjacent optional can otherwise steal a segment.
      assert.equal(normalize('{/:a}{/:b/:c}', {}, '/B/C'), null)
      assert.equal(normalize('/x{/:a/:b}', {}, '/x/1/2'), null)
      // group owns a token in one segment ('ab') and a full later segment ('/:c')
      assert.equal(normalize('/a{b/:c}{/:d}', {}, '/a/d'), null)
    })

    it('rejects an optional trailing/interior slash group', () => {
      assert.equal(normalize('/users{/}', {}, '/users/'), null)
      assert.equal(normalize('/items{/:id/}', {}, '/items/42/'), null)
    })

    it('rejects adjacent dynamic tokens with no static between (Express rejects these too)', () => {
      assert.equal(normalize('/:a:b', { a: '1', b: '2' }, '/12'), null)
      assert.equal(normalize('/:a*rest', {}, '/1/2'), null)
    })

    it('still supports a static-only intra-segment optional group', () => {
      assert.equal(normalize('/foo{bar}', {}, '/foobar'), '/foobar')
      assert.equal(normalize('/foo{bar}', {}, '/foo'), '/foo')
      // trailing static after the optional group exercises the mid-segment group close
      assert.equal(normalize('/foo{bar}baz', {}, '/foobarbaz'), '/foobarbaz')
      assert.equal(normalize('/foo{bar}baz', {}, '/foobaz'), '/foobaz')
    })

    it('supports multiple static optional groups in one segment (literal, no ambiguity)', () => {
      assert.equal(normalize('/a{b}{c}', {}, '/abc'), '/abc')
      assert.equal(normalize('/a{b}{c}', {}, '/ab'), '/ab')
      assert.equal(normalize('/a{b}{c}', {}, '/ac'), '/ac')
      assert.equal(normalize('/a{b}{c}', {}, '/a'), '/a')
    })

    it('rolls back a static intra-segment marker when a later segment fails, then uses params', () => {
      // '/foobar' matches the first segment (marker recorded), but '/w' != '/z' fails the tail, so
      // the URL match is abandoned and params (empty) decide: the optional static is absent.
      assert.equal(normalize('/foo{bar}/z', {}, '/foobar/w'), '/foo/z')
    })
  })

  describe('URL-based optional resolution (mergeParams=false fix)', () => {
    it('resolves present optional param from URL when absent from req.params', () => {
      // app.use('/api{/:version}', router) without mergeParams — req.params = {} in sub-handler
      assert.equal(normalize('/api{/:version}/users', {}, '/api/v1/users'), '/api/{version}/users')
    })

    it('resolves absent optional param from URL', () => {
      assert.equal(normalize('/api{/:version}/users', {}, '/api/users'), '/api/users')
    })

    it('falls back to params when urlPath is not provided', () => {
      // Without urlPath, empty params → optional treated as absent
      assert.equal(normalize('/api{/:version}/users', {}), '/api/users')
    })

    it('falls back to params when URL does not match route', () => {
      assert.equal(
        normalize('/api{/:version}/users', { version: 'v2' }, '/completely/different/path'),
        '/api/{version}/users'
      )
    })

    it('resolves multiple optional params from URL — both present', () => {
      assert.equal(normalize('/a{/:x}{/:y}/b', {}, '/a/1/2/b'), '/a/{x}/{y}/b')
    })

    it('resolves multiple optional params from URL — first present only', () => {
      assert.equal(normalize('/a{/:x}{/:y}/b', {}, '/a/1/b'), '/a/{x}/b')
    })

    it('resolves multiple optional params from URL — none present', () => {
      assert.equal(normalize('/a{/:x}{/:y}/b', {}, '/a/b'), '/a/b')
    })

    it('resolves multi-param segment params from URL', () => {
      assert.equal(normalize('/photos/:id.:format', {}, '/photos/1.jpg'), '/photos/{id+format}')
    })

    it('req.params is still used when no urlPath and optional is present', () => {
      assert.equal(normalize('/items{/:id}', { id: '5' }), '/items/{id}')
    })

    it('URL is authoritative: recovers a mergeParams-dropped parent optional param', () => {
      assert.equal(
        normalize('/api{/:version}/users{/:id}', { id: '42' }, '/api/v1/users/42'),
        '/api/{version}/users/{id}'
      )
    })

    it('does not mark an absent optional present when a name is shared across groups', () => {
      assert.equal(normalize('/:id{/:id}', { id: 'x' }, '/x'), '/{id}')
      assert.equal(normalize('/a{/:x}/b{/:x}', { x: 'v' }, '/a/b/v'), '/a/b/{x}')
    })

    it('captures a named wildcard after an optional segment (greedy: optional fills first)', () => {
      // path-to-regexp is greedy left-to-right: {/:id} takes the first URL segment, *rest the rest.
      assert.equal(normalize('/files{/:id}/*rest', {}, '/files/x/y/z'), '/files/{id}/{rest}')
    })

    it('does not mark a preceding optional present when a required wildcard needs the last segment', () => {
      // The required '*rest' needs >=1 segment, so '/files/x' assigns rest=x and id is absent —
      // it must not shift x into {/:id} and let the wildcard match zero segments.
      assert.equal(normalize('/files{/:id}/*rest', {}, '/files/x'), '/files/{rest}')
    })
  })

  describe('static segment encoding (UTF-8 correctness)', () => {
    it('encodes multi-byte UTF-8 characters correctly', () => {
      // é (U+00E9) encodes to %C3%A9 in UTF-8, not %E9 (Latin-1)
      assert.equal(normalize('/path/café', {}), '/path/caf%C3%A9')
    })

    it('encodes characters not in [A-Za-z0-9.-~_] via encodeURIComponent', () => {
      assert.equal(normalize('/a/b c', {}), '/a/b%20c')
      assert.equal(normalize('/a/b,c', {}), '/a/b%2Cc')
    })

    it('encodes 4-byte emoji correctly as UTF-8 (not as two U+FFFD)', () => {
      // 🚀 U+1F680 → %F0%9F%9A%80 (4 UTF-8 bytes), not %EF%BF%BD%EF%BF%BD (two surrogates)
      assert.equal(normalize('/path/🚀', {}), '/path/%F0%9F%9A%80')
    })

    it('matches a static optional against the literal route text (as Express does), encodes output', () => {
      // The URL is matched against the literal route text (what path-to-regexp/Express match), not
      // a re-encoded form; the encoded form is only for the rendered output.
      assert.equal(normalize('/posts{/café}', {}, '/posts/café'), '/posts/caf%C3%A9')
      assert.equal(normalize('/posts{/café}', {}, '/posts'), '/posts')
      // A route static that itself contains '%' must not be double-encoded when matching.
      assert.equal(normalize('/x{/a%40b}', {}, '/x/a%40b'), '/x/a%2540b')
    })

    it('treats backslash-escaped reserved chars as static (Express 5)', () => {
      assert.equal(normalize('/file/\\{id\\}', {}, '/file/{id}'), '/file/%7Bid%7D')
    })
  })

  describe('prototype property safety (:toString, :constructor)', () => {
    it('treats :id{/:x} as absent when :x not in req.params (inherited props ignored)', () => {
      // req.params = {} — Object.prototype.toString is inherited, not own → absent
      assert.equal(normalize('/x{/:toString}', {}), '/x')
      assert.equal(normalize('/x{/:constructor}', {}), '/x')
    })

    it('treats an optional param as present when explicitly in req.params', () => {
      assert.equal(normalize('/x{/:toString}', { toString: 'val' }), '/x/{toString}')
    })
  })

  describe('duplicate param names (shadowed occurrences become paramN)', () => {
    it('keeps the name on the last occurrence; earlier one becomes param1', () => {
      // Express keeps only the last value in req.params for a duplicated name, so earlier
      // occurrences have no retrievable name and are treated as nameless (RFC rule 4).
      assert.equal(normalize('/:id/:id', {}, '/x/y'), '/{param1}/{id}')
    })

    it('numbers multiple shadowed occurrences in declaration order', () => {
      assert.equal(normalize('/:id/:id/:id', {}, '/x/y/z'), '/{param1}/{param2}/{id}')
    })

    it('skips paramN that collides with a surviving framework name', () => {
      assert.equal(normalize('/:param1/:param1', {}, '/x/y'), '/{param2}/{param1}')
    })

    it('enforces name uniqueness on encoded names (no post-encode collision)', () => {
      // ':"a/b"' and ':"a%2Fb"' both encode to a%2Fb → first must be shadowed to paramN.
      assert.equal(normalize('/:"a/b"/:"a%2Fb"', {}, '/x/y'), '/{param1}/{a%2Fb}')
    })

    it('handles escaped quotes inside a quoted param name (" is allowed unencoded per rule 4)', () => {
      assert.equal(normalize('/:"a\\"b"', { 'a"b': 'x' }, '/x'), '/{a"b}')
    })
  })

  describe('performance / safety guards', () => {
    it('returns null when a route has too many optional groups (bitmask/backtracking guard)', () => {
      const route = '/r' + Array.from({ length: 33 }, (_, i) => `{/s${i + 1}}`).join('')
      assert.equal(normalize(route, {}, '/r/s33'), null)
    })

    it('does not blow up on many optional groups against a non-matching URL (step-budget bounded)', () => {
      const route = '/' + Array.from({ length: 12 }, (_, i) => `{/:p${i}}`).join('') + '/zzz'
      const url = '/' + Array.from({ length: 12 }, () => 'x').join('/') + '/nomatch'
      const result = normalize(route, {}, url)
      assert.ok(result === null || typeof result === 'string')
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
})
