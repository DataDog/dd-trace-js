'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const createBundlerBanner = require('../../src/helpers/bundler-banner')

const instrumentationsPath = JSON.stringify(require.resolve('../..'))

describe('bundled built-in ESM views', () => {
  for (const preloaded of [false, true]) {
    it(`synchronizes every hooked built-in with the tracer ${preloaded ? 'before' : 'after'} the banner`, () => {
      const names = ['child_process', 'crypto', 'dns', 'dns/promises', 'fs', 'http', 'http2', 'https',
        'net', 'url', 'vm', 'zlib']
      const source = `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        import { readFile as promisesReadFile } from 'node:fs/promises';
        ${names.map((name, index) => `import * as ns${index} from ${JSON.stringify(`node:${name}`)};`).join('\n')}
        const require = createRequire(import.meta.url);
        const names = ${JSON.stringify(names)};
        const namespaces = [${names.map((_, index) => `ns${index}`).join(',')}];
        const keys = ['execFile', 'randomBytes', 'lookup', 'lookup', 'readFile', 'request', 'connect',
          'request', 'Socket', 'parse', 'Script', 'gzip'];
        const original = namespaces.map((ns, i) => ns[keys[i]]);
        const originalPromisesReadFile = promisesReadFile;
        const connect = ns8.Socket.prototype.connect;
        ${preloaded ? `require(${instrumentationsPath});` : ''}
        ${createBundlerBanner('test')}
        ${preloaded ? '' : `require(${instrumentationsPath});`}
        for (let i = 0; i < names.length; i++) {
          const current = require('node:' + names[i]);
          assert.equal(current, namespaces[i].default, names[i] + ' exports object identity');
          assert.equal(namespaces[i][keys[i]], current[keys[i]], names[i] + ' named ESM export');
          if (names[i] !== 'net') {
            assert.notEqual(namespaces[i][keys[i]], original[i], names[i] + ' must be instrumented');
          }
        }
        assert.notEqual(ns8.Socket.prototype.connect, connect, 'net prototype must be instrumented');
        assert.equal(promisesReadFile, require('node:fs').promises.readFile, 'fs/promises named ESM export');
        assert.notEqual(promisesReadFile, originalPromisesReadFile, 'fs/promises must be instrumented');
        console.log('ok');
      `
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
        encoding: 'utf8',
      })
      assert.equal(output.trim(), 'ok')
    })
  }

  it('does not load hooked built-ins nobody imported', () => {
    const source = `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      ${createBundlerBanner('test')}
      require(${instrumentationsPath});
      console.log(JSON.stringify(['vm', 'dns/promises'].filter(name =>
        process.moduleLoadList.includes('NativeModule ' + name))));
    `
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
    })
    assert.deepStrictEqual(JSON.parse(output), [])
  })

  it('does not instrument a built-in twice when the ESM loader already did', () => {
    const source = `
      import { request } from 'node:http';
      import dc from 'node:diagnostics_channel';
      ${createBundlerBanner('test')}
      let starts = 0;
      dc.channel('apm:http:client:request:start').subscribe(({ args }) => {
        if (args.options?.port === '1' || args.options?.port === 1) starts++;
      });
      const req = request('http://127.0.0.1:1');
      req.on('error', () => {});
      req.end();
      console.log(starts);
    `
    const initialize = path.join(__dirname, '..', '..', '..', '..', 'initialize.mjs')
    const output = execFileSync(process.execPath, ['--import', initialize, '--input-type=module', '--eval', source], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_REMOTE_CONFIGURATION_ENABLED: 'false',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      },
    })
    assert.equal(output.trim(), '1')
  })
})
