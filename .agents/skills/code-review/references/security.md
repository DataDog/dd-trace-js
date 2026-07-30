# Security

Check whether the change introduces a vulnerability or exposes data:

- Follow external input across trust boundaries and look for injection, unsafe paths or commands, and insecure parsing.
- Check authentication, authorization, security controls, defaults, and failure behavior.
- Look for secrets, credentials, customer data, or sensitive headers in code, logs, span tags, config values, telemetry, fixtures, errors, commit messages, and PR text.
- Check resource ownership and concurrency where misuse could leak data or cross requests.
- Trace the real caller and sink before filing a finding.

Report a concrete exploit, disclosure path, or weakened control. A direct disclosure in commit or PR text is a finding without a behavioral path. Do not report hypothetical concerns without a reachable path in the changed behavior.
