import type { NextConfig } from 'next'

export function withDatadogTurbopack<TArguments extends unknown[]> (
  nextConfig: (...args: TArguments) => NextConfig | Promise<NextConfig>
): (...args: TArguments) => Promise<NextConfig>

export function withDatadogTurbopack (
  nextConfig?: NextConfig | Promise<NextConfig>
): (phase?: string) => Promise<NextConfig>
