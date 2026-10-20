'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const ddPlugin = require('../../esbuild')
const { sandboxCwd, useSandbox } = require('../helpers')
const FakeAgent = require('../helpers/fake-agent')

const execFileAsync = promisify(execFile)
const tracerPath = require.resolve('../..')
const initPath = require.resolve('../../init')

/**
 * @param {'cjs' | 'esm'} format
 * @param {string} prefix
 * @param {boolean} preloaded
 */
function application (format, prefix, preloaded) {
  const imports = format === 'esm'
    ? `import http, { request, createServer } from '${prefix}http';
       import dns, { lookup } from '${prefix}dns';
       import dnsPromises, { lookup as lookupPromise } from '${prefix}dns/promises';
       import fs, { readFile } from '${prefix}fs';
       import fsPromises, { readFile as readFilePromise } from '${prefix}fs/promises';`
    : `const http = require('${prefix}http');
       const { request, createServer } = http;
       const dns = require('${prefix}dns');
       const { lookup } = dns;
       const dnsPromises = require('${prefix}dns/promises');
       const { lookup: lookupPromise } = dnsPromises;
       const fs = require('${prefix}fs');
       const { readFile } = fs;
       const fsPromises = require('${prefix}fs/promises');
       const { readFile: readFilePromise } = fsPromises;`
  return `
    ${format === 'esm' ? `import tracer from ${JSON.stringify(tracerPath)};` : ''}
    ${format === 'cjs' ? `const tracer = require(${JSON.stringify(tracerPath)});` : ''}
    ${preloaded ? '' : 'tracer.init({ flushInterval: 10 });'}
    ${imports}
    const assert = require('node:assert/strict');
    const dc = require('node:diagnostics_channel');
    const counts = { client: 0, server: 0, dns: 0, fs: 0 };
    const fixture = ${JSON.stringify(__filename)};
    dc.subscribe('apm:http:client:request:start', ctx => {
      if (ctx.args.options.path === '/builtin-regression') counts.client++;
    });
    dc.subscribe('apm:http:server:request:start', ctx => {
      if (ctx.req.url === '/builtin-regression') counts.server++;
    });
    dc.subscribe('apm:dns:lookup:start', ctx => {
      if (ctx.args[0] === 'localhost') counts.dns++;
    });
    dc.subscribe('apm:fs:operation:start', ctx => {
      if (ctx.path === fixture && ['readFile', 'promises.readFile'].includes(ctx.operation)) counts.fs++;
    });
    (async () => {
      for (const read of [readFile, fs.readFile]) {
        await new Promise((resolve, reject) => read(fixture, err => err ? reject(err) : resolve()));
      }
      await readFilePromise(fixture);
      await fsPromises.readFile(fixture);
      await new Promise((resolve, reject) => lookup('localhost', err => err ? reject(err) : resolve()));
      await new Promise((resolve, reject) => dns.lookup('localhost', err => err ? reject(err) : resolve()));
      await lookupPromise('localhost');
      await dnsPromises.lookup('localhost');
      for (const [serverFactory, clientRequest] of [[createServer, request], [http.createServer, http.request]]) {
        const server = serverFactory((req, res) => {
          assert.ok(tracer.scope().active(), 'server request must have an active span');
          res.end('ok');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await new Promise((resolve, reject) => {
          clientRequest('http://127.0.0.1:' + server.address().port + '/builtin-regression', res => {
            res.resume();
            res.once('end', resolve);
          }).once('error', reject).end();
        });
        await new Promise(resolve => server.close(resolve));
      }
      assert.equal(counts.client, 2, 'each HTTP client request must publish exactly once');
      assert.equal(counts.server, 2, 'each HTTP server request must publish exactly once');
      assert.equal(counts.dns, 4, 'each callback and promise DNS lookup must publish exactly once');
      assert.equal(counts.fs, 4, 'each callback and promise FS read must publish exactly once');
      process.stdout.write('builtins-ok');
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `
}

const versions = process.env.ESBUILD_VERSION ? [process.env.ESBUILD_VERSION] : ['0.16.12', 'latest']

for (const version of versions) {
  describe(`esbuild builtin instrumentation (${version})`, function () {
    this.timeout(60_000)

    let directory, agent
    let esbuild

    useSandbox([`esbuild@${version}`], false, [])

    before(() => {
      esbuild = require(require.resolve('esbuild', { paths: [sandboxCwd()] }))
    })

    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-esbuild-builtins-'))
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await Promise.all([agent.stop(), fs.rm(directory, { recursive: true, force: true })])
    })

    /**
     * @param {{ format: 'cjs' | 'esm', mode: string, prefix?: string, minify?: boolean,
     *   externalHttp?: boolean, splitting?: boolean }} options
     */
    async function check ({ format, mode, prefix = '', minify = false, externalHttp = false, splitting = false }) {
      const entry = path.join(directory, `app.${format === 'esm' ? 'mjs' : 'cjs'}`)
      await fs.writeFile(entry, application(format, prefix, mode === 'preloaded'))
      const external = ['@datadog/*', '@openfeature/server-sdk']
      if (mode !== 'bundled') external.push(tracerPath)
      if (externalHttp) external.push('http')
      const options = {
        entryPoints: [entry],
        outdir: path.join(directory, 'out'),
        outExtension: { '.js': format === 'esm' ? '.mjs' : '.cjs' },
        bundle: true,
        platform: 'node',
        format,
        minify,
        keepNames: true,
        plugins: [ddPlugin],
        external,
        splitting,
      }
      if (splitting) {
        const second = path.join(directory, 'second.mjs')
        await fs.writeFile(second, `import ${JSON.stringify(entry)};`)
        options.entryPoints.push(second)
      }
      await esbuild.build(options)
      const names = new Set()
      const received = agent.assertMessageReceived(({ payload }) => {
        for (const trace of payload) {
          for (const span of trace) names.add(span.name)
        }
        for (const name of ['http.request', 'web.request', 'dns.lookup']) {
          assert.ok(names.has(name), `missing ${name} span; received ${[...names]}`)
        }
      })
      const args = mode === 'preloaded' ? ['--require', initPath] : []
      args.push(path.join(directory, 'out', path.basename(entry)))
      const [result] = await Promise.all([
        execFileAsync(process.execPath, args, {
          env: {
            ...process.env,
            DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
            DD_TRACE_FLUSH_INTERVAL: '10',
            DD_TRACE_DEBUG: 'false',
            DD_REMOTE_CONFIGURATION_ENABLED: 'false',
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
          },
          timeout: 30_000,
        }),
        received,
      ])
      assert.match(result.stdout, /builtins-ok/)
    }

    for (const format of ['cjs', 'esm']) {
      for (const mode of ['bundled', 'external', 'preloaded']) {
        for (const prefix of ['', 'node:']) {
          it(`${format}, tracer ${mode}, ${prefix || 'bare'} named/default builtins and subpaths`, async () => {
            await check({ format, mode, prefix })
          })
        }
      }
    }

    it('instruments explicitly external HTTP ESM imports', async () => {
      await check({ format: 'esm', mode: 'external', externalHttp: true })
    })

    it('instruments minified ESM named/default builtins and subpaths', async () => {
      await check({ format: 'esm', mode: 'bundled', prefix: 'node:', minify: true })
    })

    it('registers builtins before shared static chunks copy their exports', async () => {
      await check({ format: 'esm', mode: 'external', splitting: true, externalHttp: true })
    })
  })
}
