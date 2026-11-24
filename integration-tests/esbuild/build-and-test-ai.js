'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const esbuild = require('esbuild')

const ddPlugin = require('../../esbuild')

async function main () {
  const { outputFiles } = await esbuild.build({
    stdin: {
      contents: `
        import { checkActivation, checkStream } from
          '../../packages/datadog-instrumentations/test/fixtures/ai-activation.js'
        const check = checkActivation('dd-trace:bundler:load')
        const ai = await import('ai')
        check(1)
        await checkStream(ai)
      `,
      resolveDir: __dirname,
      sourcefile: 'ai-app.mjs',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [ddPlugin],
    write: false,
  })

  // Preload the tracer, but not the ESM loader. `ai` is inside the bundle, so only
  // the bundler's activation publication can load the integration.
  const { error, status, stderr } = spawnSync(
    process.execPath, ['--require', require.resolve('../../init.js'), '--input-type=module'],
    {
      cwd: __dirname,
      env: { ...process.env, DD_TRACE_STARTUP_LOGS: 'false' },
      encoding: 'utf8',
      input: outputFiles[0].text,
      timeout: 15_000,
    }
  )
  assert.ifError(error)
  assert.strictEqual(status, 0, stderr)
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
