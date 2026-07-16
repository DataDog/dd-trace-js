import type { NextConfig } from 'next'

interface DatadogNextOptions {
  projectRoot?: string
}

declare function withDatadogConfig(config?: NextConfig, options?: DatadogNextOptions): NextConfig

export = withDatadogConfig
