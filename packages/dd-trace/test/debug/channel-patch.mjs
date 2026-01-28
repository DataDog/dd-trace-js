import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('./channel-patch.js')

export async function resolve (specifier, context, nextResolve) {
  return nextResolve(specifier, context)
}

export async function load (url, context, nextLoad) {
  return nextLoad(url, context)
}

export async function initialize () {}
