Measures the EVP `flagevaluation` evaluation cost. The `flag-eval-hook` variant
times the synchronous work a flag evaluation pays for the `FlagEvalEVPHook.finally`
hook (scalar capture + bounded enqueue) — the only cost charged to the caller's
evaluation. The `aggregate` variant times the off-hot-path aggregator
(`FlagEvaluationsWriter._aggregate`: prune + canonical context key + two-tier map
update) that runs in the deferred drain, not on the evaluation path.
