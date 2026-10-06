//! Read-only binary reference driver; never used by the application.
use noise_core::speech::{
    PitchFrame, emphasize_float, pitch_track, pre_emphasis, resample_low_pass, yin_pitch_frame,
};
use std::{env, fs};

fn frame_json(p: &PitchFrame) -> String {
    let mut s = format!("{{\"f0\":{},\"aperiodicity\":{}", p.f0, p.aperiodicity);
    if let Some(v) = p.raw_f0 {
        s.push_str(&format!(",\"rawF0\":{v}"));
    }
    if let Some(v) = p.reason {
        s.push_str(&format!(",\"reason\":\"{v}\""));
    }
    if let Some((min, max)) = p.range {
        s.push_str(&format!(",\"range\":{{\"min\":{min},\"max\":{max}}}"));
    }
    if let Some(v) = p.range_boundary_adjusted {
        s.push_str(&format!(",\"rangeBoundaryAdjusted\":{v}"));
    }
    if let Some(v) = p.numeric_tolerance_hz {
        s.push_str(&format!(",\"numericToleranceHz\":{v}"));
    }
    s.push('}');
    s
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let bytes = fs::read(&args[2]).expect("input file");
    let number = |i: usize| args[i].parse::<f64>().expect("finite config");
    match args[1].as_str() {
        "frame" => {
            let v: Vec<f64> = bytes
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect();
            println!(
                "{}",
                frame_json(&yin_pitch_frame(
                    &v,
                    number(3),
                    number(4),
                    number(5),
                    number(6)
                ))
            );
        }
        "track" => {
            let v: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            let points = pitch_track(
                &v,
                number(3),
                args[7].parse().unwrap(),
                args[8].parse().unwrap(),
                number(4),
                number(5),
                number(6),
            )
            .expect("track config");
            let lines: Vec<String> = points
                .iter()
                .map(|p| {
                    let fields = frame_json(&p.frame);
                    format!("{{\"time\":{},{}", p.time, &fields[1..])
                })
                .collect();
            println!("[{}]", lines.join(","));
        }
        op => {
            let v = if op == "resample" {
                let sig: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                resample_low_pass(
                    &sig,
                    args[3].parse().unwrap(),
                    args[4].parse().unwrap(),
                    number(5),
                )
                .expect("resample profile")
            } else if op == "pcm" {
                let pcm: Vec<i16> = bytes
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                pre_emphasis(&pcm, number(3))
            } else {
                let sig: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                emphasize_float(&sig, number(3))
            };
            let fields: Vec<String> = v.iter().map(|x| x.to_string()).collect();
            println!("[{}]", fields.join(","));
        }
    }
}
