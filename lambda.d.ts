import tracer = require('./index')

export type LambdaHandler = (...args: any[]) => any

export interface LambdaWrapOptions extends tracer.plugins.aws_lambda {}

export function wrap<THandler extends LambdaHandler>(
  handler: THandler,
  config?: LambdaWrapOptions
): ((...args: Parameters<THandler>) => Promise<Awaited<ReturnType<THandler>>>) &
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
