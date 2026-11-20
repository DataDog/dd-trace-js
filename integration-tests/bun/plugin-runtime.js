'use strict'

const { BUN } = require('../helpers/bun')

/**
 * Split NODE_OPTIONS without losing quoted preload paths. No shell expansion is performed.
 * @param {string} value
 */
function splitOptions (value) {
  const args = []
  let arg = ''
  let quote
  for (const char of value) {
    if (char === quote) {
      quote = undefined
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char
    } else if (!quote && /\s/.test(char)) {
      if (arg) args.push(arg)
      arg = ''
    } else {
      arg += char
    }
  }
  if (quote) throw new Error('Unterminated quote in Bun test NODE_OPTIONS')
  if (arg) args.push(arg)
  return args
}

/**
 * Only application forks opt in; sandbox installation and the Mocha host stay on Node.
 * @param {import('node:child_process').ForkOptions} options
 * @returns {import('node:child_process').ForkOptions}
 */
function pluginRuntimeOptions (options) {
  const env = options.env || process.env
  if (env.DD_TEST_RUNTIME !== 'bun') return options

  const args = [...splitOptions(env.NODE_OPTIONS || ''), ...(options.execArgv || [])]
  const execArgv = []
  for (let i = 0; i < args.length; i++) {
    const match = /^(--loader|--experimental-loader|--import|--require|-r)(?:=(.*))?$/.exec(args[i])
    if (!match) {
      execArgv.push(args[i])
      continue
    }
    let file = match[2] ?? args[++i]
    if (!file) throw new Error(`Missing preload path for ${match[1]}`)
    if (/dd-trace\/(?:loader-hook\.mjs|register\.js)$/.test(file)) {
      file = file.replace(/(?:loader-hook\.mjs|register\.js)$/, 'initialize.mjs')
    } else if (match[1].includes('loader')) {
      throw new Error(`Unsupported Bun test loader: ${file}`)
    }
    execArgv.push('--preload', file)
  }

  return { ...options, execPath: BUN, execArgv, env: { ...env, NODE_OPTIONS: '' } }
}

module.exports = { pluginRuntimeOptions }
