import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const vitestMajor = Number.parseInt(require('vitest/package.json').version, 10)

export const usesModeArgument = vitestMajor < 5

export function getVitestOptions (options) {
  if (usesModeArgument) return options

  const { test, ...cliOptions } = options
  return {
    root: process.cwd(),
    include: [process.env.TEST_DIR],
    ...cliOptions,
    ...test,
  }
}
