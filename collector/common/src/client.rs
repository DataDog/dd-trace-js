// TODO: Support streaming with a writer instead of slice.
pub trait Client {
    fn request(&self, data: Vec<u8>);
}
