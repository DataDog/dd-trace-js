use hashbrown::HashMap;
use std::rc::Rc;

pub type Meta = HashMap<Rc<str>, Rc<str>>;
pub type Metrics = HashMap<Rc<str>, f64>;
pub type Traces = HashMap<u64, Trace>;

#[derive(Debug)]
pub struct Span {
    pub span_type: Rc<str>,
    pub trace_id: u64,
    pub span_id: u64,
    pub parent_id: u64,
    pub name: Rc<str>,
    pub resource: Rc<str>,
    pub service: Rc<str>,
    pub error: u64,
    pub start: u64,
    pub duration: u64,
    pub meta: Meta,
    pub metrics: Metrics
}

#[derive(Debug)]
pub struct Trace {
    pub started: u64,
    pub finished: u64,
    pub spans: HashMap<u64, Span>
}
