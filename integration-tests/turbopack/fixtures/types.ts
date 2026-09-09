import type { NextConfig } from 'next'

import { withDatadogTurbopack } from 'dd-trace/next'

const objectConfig = { reactStrictMode: true } satisfies NextConfig
const objectResult: Promise<NextConfig> = withDatadogTurbopack(objectConfig)('phase-production-build')
const promiseResult: Promise<NextConfig> = withDatadogTurbopack(Promise.resolve(objectConfig))()

const functionResult: Promise<NextConfig> = withDatadogTurbopack((
  phase: string,
  context: { defaultConfig: NextConfig }
) => {
  void phase
  return context.defaultConfig
})('phase-production-build', { defaultConfig: objectConfig })

void objectResult
void promiseResult
void functionResult

// @ts-expect-error withDatadogTurbopack derives the project from the process working directory.
withDatadogTurbopack(objectConfig, { projectDir: '.' })
