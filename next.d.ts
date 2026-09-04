import type { NextConfig } from 'next'

export interface DatadogTurbopackOptions {
  projectDir?: string
}

export function withDatadogTurbopack<TArguments extends unknown[]> (
  nextConfig: (...args: TArguments) => NextConfig | Promise<NextConfig>,
  options?: DatadogTurbopackOptions
): (...args: TArguments) => Promise<NextConfig>

export function withDatadogTurbopack (
  nextConfig?: NextConfig | Promise<NextConfig>,
  options?: DatadogTurbopackOptions
): (phase?: string) => Promise<NextConfig>
