#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'

import * as esbuild from 'esbuild'

import ddPlugin from '../../esbuild.js'

// ai v7 ships ESM only and publishes its own telemetry channel, so the bundle must activate the integration
// without source rewriting.
const SCRIPT = './ai-out.mjs'

try {
  await esbuild.build({
    entryPoints: ['./ai.mjs'],
    bundle: true,
    outfile: SCRIPT,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    plugins: [ddPlugin],
    external: [
      '@datadog/native-metrics',
      '@datadog/pprof',
      '@datadog/native-appsec',
      '@datadog/native-iast-taint-tracking',
      '@datadog/native-iast-rewriter',
      '@openfeature/server-sdk',
    ],
  })

  const { status, stdout, stderr } = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
  assert.strictEqual(status, 0, stderr)

  const result = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.deepStrictEqual(result, { telemetrySubscribed: true, text: 'ok' })

  console.log('ok') // eslint-disable-line no-console
} finally {
  await fs.rm(SCRIPT, { force: true })
}
