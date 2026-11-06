export type ExposureFeatureValue = string | number | boolean;

export interface ExposureFlagMetadata {
  [key: string]: string | number | boolean | undefined;
}

export interface ExposureEvaluationDetails {
  flagKey: string;
  value?: unknown;
  variant?: string;
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
  flagMetadata?: Readonly<ExposureFlagMetadata>;
}

export interface ExposureEvaluationContext {
  targetingKey?: string;
  [key: string]: unknown;
}

/**
 * A completed flag evaluation and its Datadog exposure decision.
 */
export interface ExposureEvaluation {
  /** The flag key. */
  readonly flagKey: string;
  /** The flag key, variant, value, error and flag metadata of the evaluation. */
  readonly details: ExposureEvaluationDetails;
  /** The selected variant key, or undefined when the default value was returned. */
  readonly variant: string | undefined;
  /** The key of the selected allocation, or undefined when none was selected. */
  readonly allocation: string | undefined;
  /** The evaluation context, including the targeting key. */
  readonly context: ExposureEvaluationContext | undefined;
  /** The targeting key of the evaluation context, if readable. */
  readonly targetingKey: string | undefined;
  /**
   * True when the evaluation succeeded and selected an allocation that logs exposures,
   * whether or not this subject was already exposed.
   */
  isExposure(): boolean;
  /**
   * True when this exposure repeats one already recorded for this subject: same
   * allocation, variant and serial id.
   */
  isCacheHit(): boolean;
  /** True for a new or changed exposure: the decision the provider uses for Datadog. */
  shouldSend(): boolean;
  /**
   * The HOOK features of the selected split, such as `holdout.key`. Read-only.
   */
  getFeatures(): Readonly<Record<string, ExposureFeatureValue>>;
}

/**
 * An OpenFeature hook that hands each completed flag evaluation to a callback,
 * with the Datadog exposure decision.
 *
 * Register it with `OpenFeature.addHooks(new ExposureHook(callback))` or on a client.
 * The callback runs on the evaluation thread and must not do I/O. An exception from
 * the callback does not affect the evaluation.
 */
export declare class ExposureHook {
  constructor(callback: (evaluation: ExposureEvaluation) => void);
}
