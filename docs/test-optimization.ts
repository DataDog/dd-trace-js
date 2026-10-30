import { preventFailureSuppression, noAutoRetry } from '../test-optimization';

const numericCallback = (value: number, label: string): string => label + value;
const annotated: typeof numericCallback = preventFailureSuppression(noAutoRetry(numericCallback));
const result: string = annotated(42, 'value');
const asynchronous = noAutoRetry(async (value: number): Promise<number> => value);
const pending: Promise<number> = asynchronous(42);
const doneCallback = preventFailureSuppression((done: (error?: Error) => void): void => done());
// @ts-expect-error A done callback argument remains required.
doneCallback();
// @ts-expect-error Callback argument types are preserved.
annotated(42, 42);
// @ts-expect-error An annotation requires a function.
preventFailureSuppression(42);
void result;
void pending;

const callableWithProperties = Object.assign((value: number): number => value, {
  label: 'callback',
  reset: (): void => {},
});
const annotatedCallable: typeof callableWithProperties = noAutoRetry(preventFailureSuppression(callableWithProperties));
const callableLabel: string = annotatedCallable.label;
annotatedCallable.reset();
const callableResult: number = annotatedCallable(42);
void callableLabel;
void callableResult;
