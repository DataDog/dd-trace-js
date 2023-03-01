use hashbrown::HashMap;

pub type Traces = HashMap<u64, Trace>;

#[derive(Debug)]
pub struct Span {
    pub span_type: Option<String>,
    pub trace_id: u64,
    pub span_id: u64,
    pub parent_id: u64,
    pub name: String,
    pub resource: String,
    pub service: String,
    pub error: u64,
    pub start: u64,
    pub duration: u64,
    pub meta: HashMap<String, String>,
    pub metrics: HashMap<String, f64>
}

#[derive(Debug)]
pub struct Trace {
    pub started: u64,
    pub finished: u64,
    pub spans: HashMap<u64, Span>
}
