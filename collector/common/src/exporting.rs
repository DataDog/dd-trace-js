use crate::tracing::Traces;

pub mod agent;

pub trait Exporter {
    fn export(&self, traces: Traces);
}
