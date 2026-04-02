/**
 * Wraps a Next.js Server Action with Datadog APM tracing.
 * Creates a child span under the active HTTP span with the action name as operation name.
 */
export function withDatadogServerAction<T>(actionName: string, action: () => Promise<T>): Promise<T>;

/**
 * Returns Datadog trace metadata for RUM↔APM correlation.
 * Use in `generateMetadata` in your root layout.
 */
export function getDatadogTraceMetadata(): { other?: Record<string, string> };

/**
 * Handler for Next.js `onRequestError` instrumentation hook.
 * Export as `onRequestError` from `instrumentation.ts`.
 */
export function datadogOnRequestError(
  error: { message: string; stack?: string; digest?: string },
  request: { path: string; method: string; headers: Record<string, string | undefined> },
  context: { routerKind: string; routePath: string; routeType: string; renderSource?: string }
): void;
