//! `PUT /v0.4/traces`, run from `FlushToAgent::compute` on N-API's worker pool after
//! `flush()` has already returned to JS.
//!
//! `ureq` rather than `reqwest`: `reqwest`'s blocking mode starts its own tokio
//! runtime purely to `block_on`, which is exactly the overhead being avoided here,
//! and `hyper` has had no synchronous client since 1.x. One `ureq::Agent` is built
//! once and reused across flushes so the connection stays keep-alive.

use std::time::Duration;

// PoC defaults, generous for a local agent and not tuned. `ureq` has no default
// timeouts at all, so leaving them unset would let a wedged agent pin a worker.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(2);

pub struct AgentClient {
    agent: ureq::Agent,
    endpoint: String,
    tracer_version: String,
    node_version: String,
}

impl AgentClient {
    pub fn new(base_url: &str, tracer_version: String, node_version: String) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(READ_TIMEOUT))
            .build();

        Self {
            agent: config.new_agent(),
            endpoint: format!("{}{}", base_url.trim_end_matches('/'), crate::encode::AGENT_PATH),
            tracer_version,
            node_version,
        }
    }

    /// The same headers `AgentWriter.makeRequest` sends today.
    pub fn send(&self, payload: &[u8], trace_count: usize) -> Result<(), String> {
        self.agent
            .put(&self.endpoint)
            .header("Content-Type", "application/msgpack")
            .header("Datadog-Meta-Tracer-Version", &self.tracer_version)
            .header("X-Datadog-Trace-Count", &trace_count.to_string())
            .header("Datadog-Meta-Lang", "nodejs")
            .header("Datadog-Meta-Lang-Version", &self.node_version)
            .header("Datadog-Meta-Lang-Interpreter", "v8")
            .send(payload)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}
