import { load as iitmLoad, resolve as iitmResolve } from 'import-in-the-middle/hook.mjs'

import configHelper from '../../../dd-trace/src/config/helper.js'

// This file must support Node.js 12.0.0 syntax

// Vitest isolate:true runs each test file in a worker, so the default ESM loader cost is paid per suite.
// This worker loader keeps import-in-the-middle on the path only for the Vitest and HTTP modules that
// Test Optimization needs inside workers, while letting unrelated imports resolve without rewriter setup.
const VITEST_WORKER_INSTRUMENTATION_INCLUDES = [
  '@vitest/runner',
  'http',
  'http2',
  'https',
  /node_modules\/vitest\/dist\/runners\.js$/,
  /node_modules\/vitest\/dist\/chunks\/test\..+\.js$/,
]
const VITEST_WORKER_BUILTIN_INSTRUMENTATIONS = new Set([
  'http',
  'http2',
  'https',
  'node:http',
  'node:http2',
  'node:https',
])
const VITEST_WORKER_MODULE_PATHS = [
  '/node_modules/@vitest/runner/dist/index.js',
  '/node_modules/vitest/dist/runners.js',
  '/node_modules/vitest/dist/chunks/test.',
]
const vitestWorkerLoader = {
  addInstrumentations,
  load,
  resolve,
}

// For some reason `getEnvironmentVariable` is not otherwise available to ESM.
const env = configHelper.getEnvironmentVariable

function getVitestWorkerLoader () {
  if (env('DD_VITEST_WORKER')) {
    return vitestWorkerLoader
  }
}

function addInstrumentations (data) {
  data.include.push(...VITEST_WORKER_INSTRUMENTATION_INCLUDES)
}

function load (url, context, nextLoad) {
  return iitmLoad(url, context, nextLoad)
}

async function resolve (specifier, context, nextResolve) {
  if (hasIitm(specifier) || hasIitm(context.parentURL)) {
    return iitmResolve(specifier, context, nextResolve)
  }

  const result = await nextResolve(specifier, context)
  if (
    context.parentURL === '' ||
    !shouldInstrumentVitestModule(specifier, result.url)
  ) {
    return result
  }
  return iitmResolve(specifier, context, nextResolve)
}

function hasIitm (url) {
  return typeof url === 'string' && url.includes('iitm')
}

function shouldInstrumentVitestModule (specifier, url) {
  if (
    VITEST_WORKER_BUILTIN_INSTRUMENTATIONS.has(specifier) ||
    VITEST_WORKER_BUILTIN_INSTRUMENTATIONS.has(url)
  ) {
    return true
  }
  if (typeof url !== 'string' || !url.startsWith('file:')) return false
  for (const modulePath of VITEST_WORKER_MODULE_PATHS) {
    if (url.includes(modulePath)) return true
  }
  return false
}

export { getVitestWorkerLoader }
