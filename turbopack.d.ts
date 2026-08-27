export interface TurbopackConfiguration {
  rules?: Record<string, unknown>
  resolveAlias?: Record<string, unknown>
}

/**
 * Adds Node.js Turbopack rules for supported dd-trace integrations.
 */
export function withDatadogTurbopack<T extends object> (
  turbopack?: T,
  projectDir?: string
): Promise<T & TurbopackConfiguration>
