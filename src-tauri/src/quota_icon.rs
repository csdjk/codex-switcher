//! Windows taskbar and notification-area quota indicator, rendered without assets.
use crate::types::UsageInfo;

#[path = "quota_icon_text.rs"]
mod text;

const SIZE: u32 = 32;
const SUPERSAMPLE: u32 = 4;
const HI_SIZE: u32 = SIZE * SUPERSAMPLE;
type Color = [u8; 4];
const TRACK: Color = [44, 57, 69, 255];
const UNKNOWN: Color = [166, 180, 195, 255];

/// Every reported limit must have capacity. Show the smallest remaining window.
pub fn remaining(usage: Option<&UsageInfo>) -> Option<u8> {
    let usage = usage.filter(|usage| usage.error.is_none())?;
    [usage.primary_used_percent, usage.secondary_used_percent]
        .into_iter()
        .flatten()
        .filter(|used| used.is_finite())
        .map(|used| (100.0 - used).clamp(0.0, 100.0))
        .reduce(f64::min)
        .map(|value| value.round() as u8)
}

fn color(remaining: Option<u8>) -> Color {
    match remaining {
        Some(0..=10) => [255, 91, 111, 255],
        Some(11..=30) => [255, 199, 70, 255],
        Some(_) => [73, 236, 180, 255],
        None => UNKNOWN,
    }
}

/// A small matte dial: a slender luminous arc, a quiet graphite track and
/// optically centered outline-font numerals. All geometry is in 32px units.
pub fn render(remaining: Option<u8>) -> tauri::image::Image<'static> {
    let remaining = remaining.map(|value| value.min(100));
    let mut hi = vec![0; (HI_SIZE * HI_SIZE * 4) as usize];
    let arc = remaining.filter(|value| *value > 0).map(ProgressArc::new);
    let accent = color(remaining);
    let track = match remaining {
        None => [71, 83, 98, 255],
        Some(0) => mix(TRACK, accent, 0.30),
        _ => TRACK,
    };

    for y in 0..HI_SIZE {
        for x in 0..HI_SIZE {
            let dx = (x as f32 + 0.5) / SUPERSAMPLE as f32 - SIZE as f32 / 2.0;
            let dy = (y as f32 + 0.5) / SUPERSAMPLE as f32 - SIZE as f32 / 2.0;
            let distance = dx.hypot(dy);
            let radial_delta = (distance - RING_RADIUS).abs();

            // A continuous disc removes the old bright seam between the text
            // well and ring. The small top-to-bottom lift stays intentionally matte.
            if distance <= RING_RADIUS + RING_HALF_WIDTH {
                let vertical = ((dy + 14.0) / 28.0).clamp(0.0, 1.0);
                let disc = mix([31, 43, 54, 255], [12, 20, 29, 255], vertical);
                blend_pixel_hi(&mut hi, x, y, disc);
            }
            if radial_delta <= RING_HALF_WIDTH {
                blend_pixel_hi(&mut hi, x, y, track);
            }

            if let Some(arc) = &arc {
                let stroke_distance = arc.distance(dx, dy);
                let outside = (stroke_distance - RING_HALF_WIDTH).max(0.0);
                // The distance field includes the round caps, so the halo fades
                // smoothly around the endpoints instead of ending in a hard wedge.
                let canvas_fade = ((15.75 - distance) / 0.7).clamp(0.0, 1.0);
                let glow = (-outside * outside / 0.65).exp() * 0.18 * canvas_fade;
                if glow > 0.003 {
                    let mut glow_color = accent;
                    glow_color[3] = (glow * 255.0).round() as u8;
                    blend_pixel_hi(&mut hi, x, y, glow_color);
                }
                if stroke_distance <= RING_HALF_WIDTH {
                    let angle = dx.atan2(-dy).rem_euclid(std::f32::consts::TAU);
                    let phase = (angle / arc.sweep).clamp(0.0, 1.0);
                    let crest = (1.0 - (distance - RING_RADIUS + 0.25).abs() / RING_HALF_WIDTH)
                        .clamp(0.0, 1.0);
                    // Tonal variation within the status color, not a rainbow.
                    let stroke = mix(
                        accent,
                        [245, 255, 252, 255],
                        0.04 + 0.24 * phase + 0.08 * crest,
                    );
                    blend_pixel_hi(&mut hi, x, y, stroke);
                }
            }
        }
    }
    render_text(&mut hi, remaining);
    tauri::image::Image::new_owned(downsample(&hi), SIZE, SIZE)
}

const RING_RADIUS: f32 = 13.0;
const RING_HALF_WIDTH: f32 = 1.25;

struct ProgressArc {
    sweep: f32,
    trim: f32,
    start: (f32, f32),
    end: (f32, f32),
}

impl ProgressArc {
    fn new(value: u8) -> Self {
        let sweep = f32::from(value.min(100)) / 100.0 * std::f32::consts::TAU;
        // Inset cap centers: without this, the rounded caps add to the visible
        // percentage and 97-99% incorrectly looks like a completely full ring.
        let trim = (RING_HALF_WIDTH / RING_RADIUS).min(sweep / 2.0);
        let point = |angle: f32| (RING_RADIUS * angle.sin(), -RING_RADIUS * angle.cos());
        Self {
            sweep,
            trim,
            start: point(trim),
            end: point(sweep - trim),
        }
    }

    fn distance(&self, x: f32, y: f32) -> f32 {
        let radial = (x.hypot(y) - RING_RADIUS).abs();
        if self.sweep >= std::f32::consts::TAU {
            return radial;
        }
        let angle = x.atan2(-y).rem_euclid(std::f32::consts::TAU);
        if angle >= self.trim && angle <= self.sweep - self.trim {
            radial
        } else {
            (x - self.start.0)
                .hypot(y - self.start.1)
                .min((x - self.end.0).hypot(y - self.end.1))
        }
    }
}

fn mix(a: Color, b: Color, amount: f32) -> Color {
    let t = amount.clamp(0.0, 1.0);
    std::array::from_fn(|i| (a[i] as f32 * (1.0 - t) + b[i] as f32 * t).round() as u8)
}

fn text_mask(remaining: Option<u8>) -> Option<&'static text::Mask> {
    use std::sync::OnceLock;
    static MASKS: [OnceLock<Option<text::Mask>>; 102] = [const { OnceLock::new() }; 102];
    let remaining = remaining.map(|value| value.min(100));
    let slot = remaining.map(usize::from).unwrap_or(101);
    MASKS[slot]
        .get_or_init(|| {
            let label = remaining
                .map(|v| v.to_string())
                .unwrap_or_else(|| "--".into());
            let em = if label.len() == 3 { 11.75 } else { 13.5 };
            text::rasterize(&label, (em * SUPERSAMPLE as f32).round() as u32, HI_SIZE)
        })
        .as_ref()
}

fn render_text(pixels: &mut [u8], remaining: Option<u8>) {
    let ink = match remaining {
        None => UNKNOWN,
        Some(0) => [255, 143, 153, 255],
        _ => [239, 245, 249, 255],
    };
    if let Some(mask) = text_mask(remaining)
        .filter(|mask| mask.width <= 20 * SUPERSAMPLE && mask.height <= 12 * SUPERSAMPLE)
    {
        // Center the ink, not the font's em box: 1, 93 and 100 all sit correctly.
        let left = (HI_SIZE - mask.width) / 2;
        let top = (HI_SIZE - mask.height) / 2;
        for y in 0..mask.height {
            for x in 0..mask.width {
                let mut pixel = ink;
                pixel[3] = mask.alpha[(y * mask.width + x) as usize];
                blend_pixel_hi(pixels, left + x, top + y, pixel);
            }
        }
        return;
    }
    // A smaller asset-free fallback preserves the value if GDI is unavailable.
    // No shadow: a per-cell shadow used to darken adjacent digit strokes.
    let label = remaining
        .map(|v| v.to_string())
        .unwrap_or_else(|| "--".into());
    let scale = if label.len() == 3 { 4 } else { 5 };
    let width = label.len() as u32 * 6 * scale - scale;
    let left = (HI_SIZE - width) / 2;
    let top = (HI_SIZE - 7 * scale) / 2;
    for (index, character) in label.chars().enumerate() {
        for (row, bits) in glyph(character).into_iter().enumerate() {
            for column in 0..5 {
                if bits & (1 << (4 - column)) != 0 {
                    rect_hi(
                        pixels,
                        left + index as u32 * 6 * scale + column * scale,
                        top + row as u32 * scale,
                        scale,
                        scale,
                        ink,
                    );
                }
            }
        }
    }
}

fn blend_pixel_hi(pixels: &mut [u8], x: u32, y: u32, color: Color) {
    let offset = ((y * HI_SIZE + x) * 4) as usize;
    let src_alpha = color[3] as f32 / 255.0;
    if src_alpha <= 0.0 {
        return;
    }
    let dst_alpha = pixels[offset + 3] as f32 / 255.0;
    let out_alpha = src_alpha + dst_alpha * (1.0 - src_alpha);
    for channel in 0..3 {
        let src = color[channel] as f32;
        let dst = pixels[offset + channel] as f32;
        pixels[offset + channel] = if out_alpha <= f32::EPSILON {
            0
        } else {
            ((src * src_alpha + dst * dst_alpha * (1.0 - src_alpha)) / out_alpha)
                .round()
                .clamp(0.0, 255.0) as u8
        };
    }
    pixels[offset + 3] = (out_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
}

fn rect_hi(pixels: &mut [u8], x: u32, y: u32, width: u32, height: u32, color: Color) {
    for row in y..y + height {
        for column in x..x + width {
            blend_pixel_hi(pixels, column, row, color);
        }
    }
}

fn downsample(hi: &[u8]) -> Vec<u8> {
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
    let samples = (SUPERSAMPLE * SUPERSAMPLE) as f32;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut alpha_sum = 0.0_f32;
            let mut premul = [0.0_f32; 3];
            for sy in 0..SUPERSAMPLE {
                for sx in 0..SUPERSAMPLE {
                    let hx = x * SUPERSAMPLE + sx;
                    let hy = y * SUPERSAMPLE + sy;
                    let hi_offset = ((hy * HI_SIZE + hx) * 4) as usize;
                    let alpha = hi[hi_offset + 3] as f32 / 255.0;
                    alpha_sum += alpha;
                    for channel in 0..3 {
                        premul[channel] += hi[hi_offset + channel] as f32 * alpha;
                    }
                }
            }
            let out_offset = ((y * SIZE + x) * 4) as usize;
            let out_alpha = alpha_sum / samples;
            if alpha_sum > f32::EPSILON {
                for channel in 0..3 {
                    rgba[out_offset + channel] =
                        (premul[channel] / alpha_sum).round().clamp(0.0, 255.0) as u8;
                }
            }
            rgba[out_offset + 3] = (out_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    rgba
}

fn glyph(character: char) -> [u8; 7] {
    match character {
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [30, 1, 1, 14, 1, 1, 30],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 16, 30, 1, 1, 30],
        '6' => [14, 16, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 1, 14],
        _ => [0, 0, 0, 31, 0, 0, 0],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn usage(primary: Option<f64>, secondary: Option<f64>) -> UsageInfo {
        serde_json::from_value(serde_json::json!({
            "account_id":"test", "plan_type":"pro", "primary_used_percent":primary,
            "secondary_used_percent":secondary
        }))
        .unwrap()
    }

    #[test]
    fn quota_icon_uses_remaining_and_the_most_restrictive_available_window() {
        assert_eq!(remaining(Some(&usage(Some(12.0), Some(73.0)))), Some(27));
        assert_eq!(remaining(Some(&usage(None, Some(73.0)))), Some(27));
        assert_eq!(remaining(Some(&usage(Some(100.0), Some(0.0)))), Some(0));
        assert_eq!(remaining(Some(&usage(Some(-1.0), None))), Some(100));
        assert_eq!(remaining(Some(&usage(Some(101.0), None))), Some(0));
    }

    #[test]
    fn quota_icon_error_and_missing_values_are_not_zero_or_old_usage() {
        let mut failed = usage(Some(25.0), None);
        failed.error = Some("network error".into());
        assert_eq!(remaining(Some(&failed)), None);
        assert_eq!(remaining(None), None);
        assert_eq!(remaining(Some(&usage(None, None))), None);
        failed.error = None;
        failed.primary_used_percent = Some(f64::NAN);
        assert_eq!(remaining(Some(&failed)), None);
    }

    #[test]
    fn quota_icon_status_colors_change_at_the_documented_thresholds() {
        assert_eq!(color(Some(31)), color(Some(100)));
        assert_eq!(color(Some(11)), color(Some(30)));
        assert_eq!(color(Some(0)), color(Some(10)));
        assert_ne!(color(Some(10)), color(Some(11)));
        assert_ne!(color(Some(30)), color(Some(31)));
        assert_ne!(color(None), color(Some(0)));
    }

    #[test]
    fn quota_icon_round_caps_keep_the_partial_ring_gap_and_clockwise_direction() {
        let point = |angle: f32| (RING_RADIUS * angle.sin(), -RING_RADIUS * angle.cos());
        let quarter = ProgressArc::new(25);
        let (x, y) = point(std::f32::consts::FRAC_PI_4);
        assert!(quarter.distance(x, y) < RING_HALF_WIDTH);
        let (x, y) = point(std::f32::consts::PI);
        assert!(quarter.distance(x, y) > RING_HALF_WIDTH);
        let almost_full = ProgressArc::new(99);
        let (x, y) = point(std::f32::consts::TAU * 0.995);
        assert!(almost_full.distance(x, y) > RING_HALF_WIDTH);
        assert!(ProgressArc::new(100).distance(x, y) < 0.001);
    }

    #[test]
    fn quota_icon_native_numerals_are_small_centered_and_clear_of_the_ring() {
        for value in (0..=100).map(Some).chain(std::iter::once(None)) {
            let mask = text_mask(value).expect("Windows native font rasterization");
            assert_eq!(mask.alpha.len(), (mask.width * mask.height) as usize);
            assert!(mask.alpha.iter().any(|alpha| *alpha > 200));
            let half_width = mask.width as f32 / SUPERSAMPLE as f32 / 2.0;
            let half_height = mask.height as f32 / SUPERSAMPLE as f32 / 2.0;
            assert!(half_height <= 5.5, "height too large: {value:?}");
            assert!(
                half_width.hypot(half_height) < RING_RADIUS - RING_HALF_WIDTH - 1.0,
                "text collides with the ring: {value:?}"
            );
        }
    }

    #[test]
    fn quota_icon_clamps_invalid_render_values_and_keeps_soft_transparent_edges() {
        assert_eq!(render(Some(255)).rgba(), render(Some(100)).rgba());
        let image = render(Some(93));
        assert!(image
            .rgba()
            .chunks_exact(4)
            .any(|pixel| pixel[3] > 0 && pixel[3] < 255));
        for (i, pixel) in image.rgba().chunks_exact(4).enumerate() {
            let x = i % SIZE as usize;
            let y = i / SIZE as usize;
            if (x < 3 || x >= 29) && (y < 3 || y >= 29) {
                assert_eq!(pixel[3], 0);
            }
        }
    }

    #[test]
    fn quota_icon_rendering_handles_all_percentages_and_unknown() {
        for value in (0..=100).map(Some).chain(std::iter::once(None)) {
            let image = render(value);
            assert_eq!(image.rgba().len(), 32 * 32 * 4);
            assert_eq!(&image.rgba()[0..4], &[0, 0, 0, 0]);
        }
        assert_ne!(render(Some(0)).rgba(), render(None).rgba());
        assert_ne!(render(Some(27)).rgba(), render(Some(80)).rgba());
    }
}
