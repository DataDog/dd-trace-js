import tracer = require('./index')

export type LambdaHandler = (...args: any[]) => any

export interface LambdaWrapOptions extends tracer.plugins.aws_lambda {
  /** Legacy datadog-lambda-js spelling. mergeXrayTraces takes precedence when both are supplied. */
  mergeDatadogXrayTraces?: boolean;
}

// Buffered wrappers require an event and context even when the customer handler omits them.
type LambdaHandlerArguments<THandler extends LambdaHandler> =
  Parameters<THandler> extends [unknown, unknown, ...unknown[]]
    ? Parameters<THandler>
    : Parameters<THandler> extends [event?: infer TEvent, context?: infer TContext, ...unknown[]]
      ? [event: TEvent, context: TContext & object]
      : [event: unknown, context: object]

export function wrap<THandler extends LambdaHandler>(
  handler: THandler,
  config?: LambdaWrapOptions
): ((...args: LambdaHandlerArguments<THandler>) => Promise<Awaited<ReturnType<THandler>>>) &
  Pick<THandler, keyof THandler>

export function sendDistributionMetric(name: string, value: number, ...tags: string[]): void

export function sendDistributionMetricWithDate(
  name: string,
  value: number,
  metricTime: Date,
  ...tags: string[]
): void

export function getTraceHeaders(): Record<string, string>

export interface LambdaInitFailure {
  error: Error
  functionName: string
  /** `Date.now()` at the start of handler module evaluation. */
  startTime: number
}

export function reportInitFailure(failure: LambdaInitFailure): Promise<void>
