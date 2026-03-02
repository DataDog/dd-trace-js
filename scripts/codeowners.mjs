import { resolve } from 'path'
import { FILE_DISCOVERY_STRATEGY, getFilePaths } from '@snyk/github-codeowners/dist/lib/file/index.js'
import { getOwnership } from '@snyk/github-codeowners/dist/lib/ownership/index.js'

// eslint-disable-next-line n/no-unsupported-features/node-builtins
const dir = resolve(import.meta.dirname, '..')
const strategy = FILE_DISCOVERY_STRATEGY.FILE_SYSTEM
const filePaths = await getFilePaths(dir, strategy)
const files = await getOwnership('CODEOWNERS', filePaths)

const unloved = files.filter(f => f.owners.length === 0)
const unlovedSpecs = unloved.filter(f => f.path.endsWith('.spec.js'))

if (unlovedSpecs.length > 0) {
  const list = unlovedSpecs.map(u => u.path).join('\n')

  throw new Error(`The following modules are missing a mandatory code owner: \n\n${list}`)
}
