'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const esbuild = require('esbuild')

const ddPlugin = require('../../esbuild')

const fixture = path.resolve(__dirname, '../../packages/datadog-esbuild/test/resources/conditional-exports')
const tracer = path.resolve(__dirname, '../..')

/** @param {'cjs' | 'esm'} format */
async function testSmithy (format) {
  const outfile = path.join(__dirname, `conditional-exports-out.${format === 'esm' ? 'mjs' : 'js'}`)
  try {
    const result = await esbuild.build({
      stdin: {
        contents: `
          require(${JSON.stringify(tracer)}).init({ startupLogs: false })
          const assert = require('node:assert/strict')
          const dc = require('dc-polyfill')
          let calls = 0
          dc.channel('apm:aws:request:start:default').subscribe(() => calls++)
          const { Client } = require('@smithy/core/client')
          const { resolveCustomEndpointsConfig } = require('@smithy/core/config')
          const config = resolveCustomEndpointsConfig({
            endpoint: 'http://localhost',
            /** @param {string} value */
            urlParser: value => value,
          })
          assert.strictEqual(typeof config.endpoint, 'function')
          const client = new Client({ serviceId: 'fixture', region: async () => 'us-east-1' })
          client.send({
            input: {},
            resolveMiddleware: () => async () => ({ output: { result: 'ok' } }),
          }).then(/** @param {{result: string}} output */ output => {
            assert.strictEqual(output.result, 'ok')
            assert.strictEqual(calls, 1)
          })
        `,
        resolveDir: __dirname,
        sourcefile: path.join(__dirname, 'node_modules/consumer/index.js'),
      },
      bundle: true,
      platform: 'node',
      format,
      outfile,
      metafile: true,
      plugins: [ddPlugin],
      external: [tracer],
    })
    const smithyInputs = Object.keys(result.metafile.inputs).filter(
      /** @param {string} input */
      input => input.includes('@smithy/core/')
    )
    assert.strictEqual(smithyInputs.some(
      /** @param {string} input */
      input => input.includes('/dist-es/')
    ), false)
    assert.strictEqual(smithyInputs.some(
      /** @param {string} input */
      input => input.includes('/dist-cjs/')
    ), true)
    const executed = spawnSync(process.execPath, [outfile], { encoding: 'utf8' })
    assert.strictEqual(executed.status, 0, executed.stderr || String(executed.error))
  } finally {
    fs.rmSync(outfile, { force: true })
  }
}

/** @param {import('esbuild').BuildOptions} extra */
async function buildFixture (extra) {
  return esbuild.build({
    absWorkingDir: fixture,
    stdin: {
      contents: 'console.log(require("@smithy/core/schema").variant)',
      resolveDir: fixture,
      sourcefile: path.join(fixture, 'node_modules/consumer/index.js'),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    plugins: [ddPlugin],
    ...extra,
  })
}

async function main () {
  await Promise.all(['cjs', 'esm'].map(testSmithy))

  const graphql = await esbuild.build({
    stdin: {
      contents: `
        import { buildSchema, GraphQLSchema as ImportedSchema } from 'graphql'
        const { graphqlSync, GraphQLSchema: RequiredSchema } = require('graphql')
        const schema = buildSchema('type Query { hello: String }')
        console.log(ImportedSchema === RequiredSchema, graphqlSync({
          schema,
          source: '{hello}',
          rootValue: { hello: 'ok' },
        }).data.hello)
      `,
      resolveDir: tracer,
      sourcefile: path.join(tracer, 'node_modules/consumer/index.js'),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [ddPlugin],
  })
  const graphqlValues = []
  vm.runInNewContext(graphql.outputFiles[0].text, {
    AbortController,
    AbortSignal,
    console: {
      /**
       * @param {boolean} identical
       * @param {string} value
       */
      log: (identical, value) => graphqlValues.push(identical, value),
    },
    process,
    require,
  })
  assert.deepStrictEqual(graphqlValues, [true, 'ok'])

  for (const external of [['@smithy/core'], ['@smithy/core/*']]) {
    const result = await buildFixture({ external })
    assert.strictEqual(Object.keys(result.metafile.inputs).some(
      /** @param {string} input */
      input => input.includes('@smithy/core/')
    ), false)
    assert.deepStrictEqual(Object.values(result.metafile.outputs)[0].imports, [
      { path: '@smithy/core/schema', kind: 'require-call', external: true },
    ])
  }

  if (esbuild.version !== '0.16.12') {
    const result = await buildFixture({ packages: 'external' })
    assert.strictEqual(Object.keys(result.metafile.inputs).some(
      /** @param {string} input */
      input => input.includes('@smithy/core/')
    ), false)
    assert.strictEqual(Object.values(result.metafile.outputs)[0].imports[0].external, true)
  }

  for (const extra of [
    {},
    { conditions: ['module'] },
    { conditions: [] },
    { alias: { '@smithy/core/schema': path.join(fixture, 'node_modules/not-instrumented/dist-es/index.js') } },
    { alias: { '@smithy/core': 'not-instrumented' } },
  ]) {
    const result = await buildFixture(extra)
    const values = []
    vm.runInNewContext(result.outputFiles[0].text, {
      console: {
        /** @param {string} value */
        log: value => values.push(value),
      },
      process,
    })
    assert.deepStrictEqual(values, [extra.conditions?.includes('module') || extra.alias ? 'dist-es' : 'dist-cjs'])
  }

  const pluginData = { owner: 'other-plugin' }
  const importer = path.join(fixture, 'node_modules/consumer/index.js')
  let observed
  const result = await esbuild.build({
    entryPoints: [importer],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [ddPlugin, {
      name: 'other-plugin',
      /** @param {import('esbuild').PluginBuild} build */
      setup (build) {
        build.onResolve({ filter: /consumer\/index\.js$/ }, () => ({ path: importer }))
        build.onLoad({ filter: /consumer\/index\.js$/ }, () => ({
          contents: 'console.log(require("@smithy/core/schema").variant)',
          resolveDir: fixture,
          pluginData,
        }))
        build.onResolve({ filter: /^@smithy\/core\/schema$/ },
          /** @param {import('esbuild').OnResolveArgs} args */
          args => { observed = args.pluginData })
      },
    }],
  })
  assert.strictEqual(observed, pluginData)
  assert.match(result.outputFiles[0].text, /dist-es/)
}

main().catch(/** @param {Error} error */ error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
