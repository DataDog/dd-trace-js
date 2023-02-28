use crate::tracing::Traces;

pub mod agent;

pub trait Encoder {
    fn encode(&self, traces: Traces);
}

pub trait Exporter {
    fn export(&self, traces: Traces);
}
