import type { NextConfig } from 'next'

import { withDatadogTurbopack } from 'dd-trace/next'

const objectConfig = { reactStrictMode: true } satisfies NextConfig
const objectResult: NextConfig = withDatadogTurbopack(objectConfig)('phase-production-build')
const promiseResult: Promise<NextConfig> = withDatadogTurbopack(Promise.resolve(objectConfig))()

const functionResult: NextConfig = withDatadogTurbopack((
  phase: string,
  context: { defaultConfig: NextConfig }
) => {
  void phase
  return context.defaultConfig
})('phase-production-build', { defaultConfig: objectConfig })
const undefinedResult: NextConfig = withDatadogTurbopack(() => undefined)()
const promisedUndefinedResult: Promise<NextConfig> = withDatadogTurbopack(Promise.resolve(undefined))()
const asyncUndefinedResult: Promise<NextConfig> = withDatadogTurbopack(async () => undefined)()

void objectResult
void promiseResult
void functionResult
void undefinedResult
void promisedUndefinedResult
void asyncUndefinedResult

// @ts-expect-error withDatadogTurbopack derives the project from the process working directory.
withDatadogTurbopack(objectConfig, { projectDir: '.' })
