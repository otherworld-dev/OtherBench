//! Screenshots and their coordinates: the primary monitor scaled down to fit
//! 1366x768 (never up), as PNG; points in the screenshot's pixels mapped to
//! the screen and back. Pure; the capture itself is in win.rs.

/// Screenshots are scaled to fit this, never up.
pub const MAX_SHOT: (u32, u32) = (1366, 768);
/// The largest PNG the server keeps (`MAX_TOOL_IMAGE_BYTES`). A bigger one is an error, never a result.
pub const MAX_PNG_BYTES: usize = 5_242_880;
/// The largest width or height the server reads (`COMPUTER_LIMITS.coordinateMax`).
pub const MAX_SIDE: u32 = 32767;

/// The size a `screen_w` x `screen_h` screen is captured at: the largest that
/// fits `max`, keeping its shape, never bigger than the screen, never zero.
pub fn fit(screen_w: u32, screen_h: u32, max: (u32, u32)) -> (u32, u32) {
    if screen_w == 0 || screen_h == 0 {
        return (1, 1);
    }
    let scale = (max.0 as f64 / screen_w as f64).min(max.1 as f64 / screen_h as f64).min(1.0);
    let w = ((screen_w as f64) * scale).round().clamp(1.0, max.0.max(1) as f64) as u32;
    let h = ((screen_h as f64) * scale).round().clamp(1.0, max.1.max(1) as f64) as u32;
    (w.min(screen_w), h.min(screen_h))
}

/// The session's last screenshot: its size, and the screen's size when it was taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shot {
    pub width: u32,
    pub height: u32,
    pub screen_w: u32,
    pub screen_h: u32,
}

impl Shot {
    /// Whether a point is a pixel of this screenshot.
    pub fn contains(&self, x: i64, y: i64) -> bool {
        x >= 0 && y >= 0 && x < self.width as i64 && y < self.height as i64
    }

    /// The screen point at the centre of a screenshot pixel (the primary
    /// monitor's origin is 0, 0). Inside the screen for any pixel inside.
    pub fn to_screen(&self, x: u32, y: u32) -> (i32, i32) {
        let along = |p: u32, size: u32, screen: u32| ((2 * p as u64 + 1) * screen as u64 / (2 * size.max(1) as u64)).min(screen.saturating_sub(1) as u64) as i32;
        (along(x, self.width, self.screen_w), along(y, self.height, self.screen_h))
    }

    /// The screenshot pixel a screen point falls in; None off the primary
    /// monitor (a negative point, another monitor): never clamped.
    pub fn from_screen(&self, sx: i32, sy: i32) -> Option<(u32, u32)> {
        if sx < 0 || sy < 0 || sx as u32 >= self.screen_w || sy as u32 >= self.screen_h {
            return None;
        }
        let x = (sx as u64 * self.width as u64 / self.screen_w.max(1) as u64) as u32;
        let y = (sy as u64 * self.height as u64 / self.screen_h.max(1) as u64) as u32;
        (x < self.width && y < self.height).then_some((x, y))
    }
}

/// GDI's top-down 32-bit BGRA rows as an RGB PNG.
pub fn encode_png(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE || bgra.len() != width as usize * height as usize * 4 {
        return Err("Grunt couldn't capture the screen.".into());
    }
    let rgb: Vec<u8> = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| "Grunt couldn't encode the screenshot.".to_string())?;
        writer.write_image_data(&rgb).map_err(|_| "Grunt couldn't encode the screenshot.".to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_down_to_fit_never_up() {
        assert_eq!(fit(1920, 1080, MAX_SHOT), (1365, 768));
        assert_eq!(fit(2560, 1440, MAX_SHOT), (1365, 768));
        assert_eq!(fit(2732, 1536, MAX_SHOT), (1366, 768));
        assert_eq!(fit(3440, 1440, MAX_SHOT), (1366, 572));
        assert_eq!(fit(1366, 768, MAX_SHOT), (1366, 768));
        assert_eq!(fit(1280, 720, MAX_SHOT), (1280, 720));
        assert_eq!(fit(1080, 1920, MAX_SHOT), (432, 768));
        assert_eq!(fit(0, 0, MAX_SHOT), (1, 1));
    }

    #[test]
    fn maps_pixels_to_the_screen_and_back_inside_it() {
        let shot = Shot { width: 1366, height: 768, screen_w: 2732, screen_h: 1536 };
        assert_eq!(shot.to_screen(0, 0), (1, 1));
        assert_eq!(shot.to_screen(100, 50), (201, 101));
        assert_eq!(shot.to_screen(1365, 767), (2731, 1535));
        assert_eq!(shot.from_screen(201, 101), Some((100, 50)));
        assert_eq!(shot.from_screen(2731, 1535), Some((1365, 767)));
        for x in [0, 1, 683, 1365] {
            let (sx, sy) = shot.to_screen(x, 767);
            assert_eq!(shot.from_screen(sx, sy), Some((x, 767)));
        }
        let same = Shot { width: 1280, height: 720, screen_w: 1280, screen_h: 720 };
        assert_eq!(same.to_screen(10, 20), (10, 20));
        assert_eq!(same.from_screen(10, 20), Some((10, 20)));
    }

    #[test]
    fn a_point_off_the_screen_is_none_never_clamped() {
        let shot = Shot { width: 1366, height: 768, screen_w: 1920, screen_h: 1080 };
        for (x, y) in [(-1, 10), (10, -1), (1920, 10), (10, 1080), (-1920, 0), (5000, 5000)] {
            assert_eq!(shot.from_screen(x, y), None, "{x},{y}");
        }
        assert!(shot.contains(0, 0) && shot.contains(1365, 767));
        for (x, y) in [(-1, 0), (0, -1), (1366, 0), (0, 768)] {
            assert!(!shot.contains(x, y), "{x},{y}");
        }
    }

    #[test]
    fn encodes_bgra_rows_as_a_png_whose_header_has_the_size() {
        let png_bytes = encode_png(&[1, 2, 3, 255, 4, 5, 6, 255], 2, 1).unwrap();
        assert_eq!(&png_bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(u32::from_be_bytes(png_bytes[16..20].try_into().unwrap()), 2);
        assert_eq!(u32::from_be_bytes(png_bytes[20..24].try_into().unwrap()), 1);
        let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes)).read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut buf).unwrap();
        assert_eq!(&buf[..6], &[3, 2, 1, 6, 5, 4]);
        assert!(encode_png(&[0; 7], 2, 1).is_err());
        assert!(encode_png(&[], 0, 0).is_err());
    }
}
