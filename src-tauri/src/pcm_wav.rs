//! Bounded-memory PCM16 WAV encoding. No model or hardware accelerator is used.
use std::io::{self, Write};

pub const ENCODE_BUFFER_BYTES: usize = 32 * 1024;

pub fn encoded_len(samples: usize) -> io::Result<i32> {
    samples
        .checked_mul(2)
        .and_then(|n| n.checked_add(44))
        .and_then(|n| i32::try_from(n).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Recording is too large to save as WAV",
            )
        })
}

pub fn write(samples: &[f32], out: &mut impl Write) -> io::Result<()> {
    let len = encoded_len(samples.len())? as u32;
    out.write_all(b"RIFF")?;
    out.write_all(&(len - 8).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16_u32.to_le_bytes())?;
    out.write_all(&1_u16.to_le_bytes())?; // PCM
    out.write_all(&1_u16.to_le_bytes())?; // mono
    out.write_all(&16000_u32.to_le_bytes())?;
    out.write_all(&32000_u32.to_le_bytes())?;
    out.write_all(&2_u16.to_le_bytes())?;
    out.write_all(&16_u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&(len - 44).to_le_bytes())?;
    let mut buffer = [0_u8; ENCODE_BUFFER_BYTES];
    for chunk in samples.chunks(ENCODE_BUFFER_BYTES / 2) {
        for (sample, bytes) in chunk.iter().zip(buffer.chunks_exact_mut(2)) {
            bytes.copy_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        out.write_all(&buffer[..chunk.len() * 2])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_encoding_matches_pcm16_wav_including_chunk_boundaries() {
        let mut samples = vec![0.125; ENCODE_BUFFER_BYTES + 13];
        samples.extend([
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
            -1.0,
            0.0,
            0.5,
            1.0,
        ]);
        let mut actual = Vec::new();
        write(&samples, &mut actual).unwrap();
        assert_eq!(actual, encode_reference(&samples));
        assert!(encoded_len(usize::MAX).is_err());
        assert!(encoded_len(i32::MAX as usize).is_err());
    }

    #[test]
    fn encoder_bounds_each_write_and_propagates_disk_errors() {
        struct Bounded {
            written: usize,
        }
        impl Write for Bounded {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                assert!(bytes.len() <= ENCODE_BUFFER_BYTES);
                self.written += bytes.len();
                if self.written > ENCODE_BUFFER_BYTES {
                    return Err(io::Error::other("Disk full"));
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert!(write(
            &vec![0.5; ENCODE_BUFFER_BYTES * 2],
            &mut Bounded { written: 0 }
        )
        .is_err());
    }
}

#[cfg(test)]
/// Encode f32 PCM samples (16kHz mono) into a WAV byte buffer.
pub fn encode_reference(samples: &[f32]) -> Vec<u8> {
    let sample_rate: u32 = 16000;
    let bits_per_sample: u16 = 16;
    let num_channels: u16 = 1;
    let byte_rate = sample_rate * (bits_per_sample as u32 / 8) * num_channels as u32;
    let block_align = num_channels * (bits_per_sample / 8);
    let data_size = (samples.len() * 2) as u32;
    let file_size = 36 + data_size;

    let mut buf = Vec::with_capacity(file_size as usize + 8);

    // RIFF header
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&file_size.to_le_bytes());
    buf.extend_from_slice(b"WAVE");

    // fmt chunk
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&num_channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());

    // data chunk
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_size.to_le_bytes());

    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let val = (clamped * 32767.0) as i16;
        buf.extend_from_slice(&val.to_le_bytes());
    }

    buf
}
