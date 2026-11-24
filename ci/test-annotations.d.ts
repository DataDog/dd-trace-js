/** Prevent Datadog from quarantining or disabling this test callback. */
export function preventFailureSuppression<T extends (...args: never[]) => unknown>(callback: T): T;

/** Prevent ATR, Early Flake Detection, and Attempt to Fix retries for this test callback. */
export function noAutoRetry<T extends (...args: never[]) => unknown>(callback: T): T;
