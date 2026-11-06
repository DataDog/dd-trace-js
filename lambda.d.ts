import tracer = require('./index')

export type LambdaHandler = (...args: any[]) => any

export interface LambdaWrapOptions extends tracer.plugins.aws_lambda {
  /**
   * Completion policy, selected when the handler is first wrapped.
   * `auto` preserves legacy callback/context completion and return-value heuristics.
   * `return` uses the returned value or Promise, including undefined, without installing callback/context adapters.
   * Only use `return` for handlers that do not complete through callbacks or context methods.
   * `callback` ignores ordinary returns and waits for a callback or context completion, regardless of arity.
   * In `auto` and `callback`, returned Promises race callback/context completion.
   * A throw rejects unless a callback/context method has already selected completion.
   * Overrides DD_LAMBDA_HANDLER_COMPLETION for this handler. Response streaming is unaffected.
   * @default 'auto'
   * @env DD_LAMBDA_HANDLER_COMPLETION
   */
  handlerCompletion?: 'auto' | 'return' | 'callback'
}

export function wrap<THandler extends LambdaHandler>(
  handler: THandler,
  config?: LambdaWrapOptions
): ((this: ThisParameterType<THandler>, ...args: Parameters<THandler>) => Promise<Awaited<ReturnType<THandler>>>) &
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
