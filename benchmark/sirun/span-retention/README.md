# Span retention

Measures post-GC heap growth when traced Express requests create long-lived async resources that capture the active
request store. The request-only workload tracks the bounded working set so retirement regressions do not hide behind
the leak-specific improvement.
