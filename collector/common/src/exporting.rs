use crate::tracing::{Traces};
use async_trait::async_trait;

pub mod agent;

#[async_trait]
pub trait Exporter {
    async fn export(&self, traces: Traces);
}
