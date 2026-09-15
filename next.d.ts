import type { NextConfig } from 'next'

type NextConfigValue = NextConfig | undefined

export function withDatadogTurbopack<TArguments extends unknown[]> (
  nextConfig: (...args: TArguments) => Promise<NextConfigValue>
): (...args: TArguments) => Promise<NextConfig>

export function withDatadogTurbopack<TArguments extends unknown[]> (
  nextConfig: (...args: TArguments) => NextConfigValue
): (...args: TArguments) => NextConfig

export function withDatadogTurbopack<TArguments extends unknown[]> (
  nextConfig: (...args: TArguments) => NextConfigValue | Promise<NextConfigValue>
): (...args: TArguments) => NextConfig | Promise<NextConfig>

export function withDatadogTurbopack (
  nextConfig: Promise<NextConfigValue>
): (phase?: string) => Promise<NextConfig>

export function withDatadogTurbopack (
  nextConfig?: NextConfigValue
): (phase?: string) => NextConfig

export function withDatadogTurbopack (
  nextConfig: NextConfigValue | Promise<NextConfigValue>
): (phase?: string) => NextConfig | Promise<NextConfig>
