'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

const createBundlerBanner = require('../../src/helpers/bundler-banner')

describe('bundled built-in ESM views', () => {
  for (const preloaded of [false, true]) {
    it(`synchronizes every hooked built-in with the tracer ${preloaded ? 'before' : 'after'} the banner`, () => {
      const names = ['child_process', 'crypto', 'dns', 'dns/promises', 'fs', 'http', 'http2', 'https',
        'net', 'url', 'vm', 'zlib']
      const source = `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        ${names.map((name, index) => `import * as ns${index} from ${JSON.stringify(`node:${name}`)};`).join('\n')}
        const require = createRequire(import.meta.url);
        const names = ${JSON.stringify(names)};
        const namespaces = [${names.map((_, index) => `ns${index}`).join(',')}];
        const keys = ['execFile', 'randomBytes', 'lookup', 'lookup', 'readFile', 'request', 'connect',
          'request', 'Socket', 'parse', 'Script', 'gzip'];
        const original = namespaces.map((ns, i) => ns[keys[i]]);
        const connect = ns8.Socket.prototype.connect;
        ${preloaded ? `require(${JSON.stringify(require.resolve('../..'))});` : ''}
        ${createBundlerBanner('test')}
        ${preloaded ? '' : `require(${JSON.stringify(require.resolve('../..'))});`}
        for (let i = 0; i < names.length; i++) {
          const current = require('node:' + names[i]);
          assert.equal(current, namespaces[i].default, names[i] + ' exports object identity');
          assert.equal(namespaces[i][keys[i]], current[keys[i]], names[i] + ' named ESM export');
          if (names[i] !== 'net') {
            assert.notEqual(namespaces[i][keys[i]], original[i], names[i] + ' must be instrumented');
          }
        }
        assert.notEqual(ns8.Socket.prototype.connect, connect, 'net prototype must be instrumented');
        console.log('ok');
      `
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
        encoding: 'utf8',
      })
      assert.equal(output.trim(), 'ok')
    })
  }
})
