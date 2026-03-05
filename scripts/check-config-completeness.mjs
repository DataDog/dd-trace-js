#!/usr/bin/env node

/* eslint-disable no-console */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const args = new Set(process.argv.slice(2))
const isVerbose = args.has('--verbose')
const isHelp = args.has('--help')

if (isHelp) {
  console.log(`
Usage: node scripts/check-config-completeness.mjs [options]

Options:
  --help      Show this help message
  --verbose   Print all matched env vars

This script validates that all environment variables read in
packages/dd-trace/src/config/index.js are registered in
packages/dd-trace/src/config/supported-configurations.json.
  `.trim())
  process.exit(0)
}

const KNOWN_EXCEPTIONS = new Set([
  'AWS_LAMBDA_FUNCTION_NAME',
  'DD_TRACE_DEBUG',
  'DD_TRACE_LOG_LEVEL',
  'JEST_WORKER_ID',
  'NX_TASK_TARGET_PROJECT',
])

const rootDir = path.join(__dirname, '..')
const configIndexPath = path.join(
  rootDir, 'packages', 'dd-trace', 'src', 'config', 'index.js',
)
const supportedConfigPath = path.join(
  rootDir, 'packages', 'dd-trace', 'src', 'config',
  'supported-configurations.json',
)

try {
  const configIndexContent = fs.readFileSync(configIndexPath, 'utf8')

  // Extract env vars from the destructuring: const { DD_VAR, OTEL_VAR, ... } = source
  const destructuringMatch = configIndexContent.match(
    /const\s+\{\s*([^}]+)\s*\}\s*=\s*source/s,
  )
  const configIndexEnvVars = new Set()

  if (destructuringMatch) {
    const destructuringContent = destructuringMatch[1]
    const varPattern =
      /\b(DD_[A-Z0-9_]+|OTEL_[A-Z0-9_]+|AWS_LAMBDA_FUNCTION_NAME|NX_TASK_TARGET_PROJECT|JEST_WORKER_ID)\b/g
    let match
    while ((match = varPattern.exec(destructuringContent)) !== null) {
      const envVar = match[1]
      if (!envVar.startsWith('_DD_')) {
        configIndexEnvVars.add(envVar)
      }
    }
  }

  const supportedConfigContent = fs.readFileSync(supportedConfigPath, 'utf8')
  const supportedConfigJson = JSON.parse(supportedConfigContent)
  const supportedConfigEnvVars = new Set(
    Object.keys(supportedConfigJson.supportedConfigurations || {}),
  )

  const missing = []
  for (const envVar of configIndexEnvVars) {
    if (!KNOWN_EXCEPTIONS.has(envVar) && !supportedConfigEnvVars.has(envVar)) {
      missing.push(envVar)
    }
  }

  if (isVerbose) {
    console.log('DD_* and OTEL_* vars found in config/index.js:')
    const sorted = [...configIndexEnvVars].sort()
    for (const v of sorted) console.log(`  ${v}`)
  }

  if (missing.length === 0) {
    console.log(`OK: All ${configIndexEnvVars.size} env vars are registered`)
    process.exit(0)
  } else {
    missing.sort()
    console.error(
      `MISSING: ${missing.length} env var(s) are read in config ` +
      'but not in supported-configurations.json:',
    )
    for (const v of missing) console.error(`  - ${v}`)
    process.exit(1)
  }
} catch (error) {
  console.error(`Error: ${error.message}`)
  process.exit(1)
}
