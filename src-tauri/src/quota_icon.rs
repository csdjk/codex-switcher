//! Windows taskbar and notification-area quota indicator, rendered without assets.
use crate::types::UsageInfo;

const SIZE: u32 = 32;
type Color = [u8; 4];
const TRACK: Color = [71, 85, 105, 255];
const UNKNOWN: Color = [203, 213, 225, 255];

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
        Some(0..=10) => [248, 113, 113, 255],
        Some(11..=30) => [251, 191, 36, 255],
        Some(_) => [52, 211, 153, 255],
        None => UNKNOWN,
    }
}

/// A high-contrast numeric gauge stays legible on both light and dark taskbars.
pub fn render(remaining: Option<u8>) -> tauri::image::Image<'static> {
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
    for y in 1..31 {
        for x in 1..31 {
            if (x == 1 || x == 30) && (y < 4 || y > 27) {
                continue;
            }
            if (y == 1 || y == 30) && (x < 4 || x > 27) {
                continue;
            }
            let border = x == 1 || x == 30 || y == 1 || y == 30;
            pixel(
                &mut rgba,
                x,
                y,
                if border {
                    [148, 163, 184, 255]
                } else {
                    [15, 23, 42, 255]
                },
            );
        }
    }

    let text = remaining
        .map(|value| value.to_string())
        .unwrap_or_else(|| "--".into());
    let scale = if text.len() == 3 { 2 } else { 3 };
    let width = text.len() as u32 * 4 * scale - scale;
    let left = (SIZE - width) / 2;
    let top = (24 - 5 * scale) / 2;
    for (index, character) in text.chars().enumerate() {
        let glyph = glyph(character);
        for (row, bits) in glyph.into_iter().enumerate() {
            for column in 0..3 {
                if bits & (1 << (2 - column)) == 0 {
                    continue;
                }
                rect(
                    &mut rgba,
                    left + index as u32 * 4 * scale + column * scale,
                    top + row as u32 * scale,
                    scale,
                    scale,
                    color(remaining),
                );
            }
        }
    }
    rect(&mut rgba, 4, 25, 24, 3, TRACK);
    if let Some(value) = remaining {
        let width = (u32::from(value) * 24 + 50) / 100;
        rect(&mut rgba, 4, 25, width, 3, color(remaining));
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

fn pixel(pixels: &mut [u8], x: u32, y: u32, color: Color) {
    let offset = ((y * SIZE + x) * 4) as usize;
    pixels[offset..offset + 4].copy_from_slice(&color);
}

fn rect(pixels: &mut [u8], x: u32, y: u32, width: u32, height: u32, color: Color) {
    for row in y..y + height {
        for column in x..x + width {
            pixel(pixels, column, row, color);
        }
    }
}

fn glyph(character: char) -> [u8; 5] {
    match character {
        '0' => [7, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 7],
        '2' => [7, 1, 7, 4, 7],
        '3' => [7, 1, 7, 1, 7],
        '4' => [5, 5, 7, 1, 1],
        '5' => [7, 4, 7, 1, 7],
        '6' => [7, 4, 7, 5, 7],
        '7' => [7, 1, 1, 1, 1],
        '8' => [7, 5, 7, 5, 7],
        '9' => [7, 5, 7, 1, 7],
        _ => [0, 0, 7, 0, 0],
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
