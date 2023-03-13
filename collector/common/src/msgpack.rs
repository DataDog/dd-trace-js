use std::io::Read;

pub use rmp::decode::{NumValueReadError, read_array_len, read_f64, read_map_len, read_str_len};

pub fn read_u16<R: Read>(mut rd: R) -> Result<u16, NumValueReadError> {
    rmp::decode::read_int(&mut rd)
}

pub fn read_u32<R: Read>(mut rd: R) -> Result<u32, NumValueReadError> {
    rmp::decode::read_int(&mut rd)
}

pub fn read_u64<R: Read>(mut rd: R) -> Result<u64, NumValueReadError> {
    rmp::decode::read_int(&mut rd)
}

pub fn read_usize<R: Read>(mut rd: R) -> Result<usize, NumValueReadError> {
    rmp::decode::read_int(&mut rd)
}

pub fn read_str<R: Read>(mut rd: R) -> String {
    let limit = read_str_len(&mut rd).unwrap() as u64;
    let mut str = String::new();

    rd.by_ref().take(limit).read_to_string(&mut str).unwrap();

    str
}
