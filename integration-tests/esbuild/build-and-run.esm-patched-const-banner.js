#!/usr/bin/env node
/* eslint-disable no-console */

const esbuild = require('esbuild')
const commonConfig = require('./build.esm.common-config')
const { spawnSync } = require('child_process')

esbuild.build({
  ...commonConfig,
  banner: {
    js: `import { createRequire } from 'module';
import { fileURLToPath  } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);`
  }
}).then(() => {
  const { status, stdout, stderr } = spawnSync('node', ['out.mjs'])
  if (stdout.length) {
    console.log(stdout.toString())
  }
  if (stderr.length) {
    console.error(stderr.toString())
  }
  if (status) {
    throw new Error('generated script failed to run')
  }
  console.log('ok')
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
