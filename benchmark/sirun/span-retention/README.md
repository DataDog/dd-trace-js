# Span retention

Measures post-GC heap growth when traced Express requests create long-lived async resources that capture the active
request store. The request-only workload omits both the retainer and forced GC so default-path throughput and RSS
regressions do not hide behind the leak-specific improvement.
