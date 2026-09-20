//! Small grayscale text masks using an installed Windows outline font.
//! No font files are bundled, copied or required in the application directory.
use std::{ffi::c_void, ptr};

type Handle = *mut c_void;

pub(super) struct Mask {
    pub width: u32,
    pub height: u32,
    pub alpha: Vec<u8>,
}

#[repr(C)]
struct BitmapInfoHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_pels_per_meter: i32,
    y_pels_per_meter: i32,
    clr_used: u32,
    clr_important: u32,
}

#[repr(C)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [u32; 1],
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(dc: Handle) -> Handle;
    fn CreateDIBSection(
        dc: Handle,
        info: *const BitmapInfo,
        usage: u32,
        bits: *mut *mut c_void,
        section: Handle,
        offset: u32,
    ) -> Handle;
    fn CreateFontW(
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u32,
        underline: u32,
        strikeout: u32,
        charset: u32,
        out_precision: u32,
        clip_precision: u32,
        quality: u32,
        pitch_and_family: u32,
        face: *const u16,
    ) -> Handle;
    fn SelectObject(dc: Handle, object: Handle) -> Handle;
    fn DeleteObject(object: Handle) -> i32;
    fn DeleteDC(dc: Handle) -> i32;
    fn SetTextColor(dc: Handle, color: u32) -> u32;
    fn SetBkMode(dc: Handle, mode: i32) -> i32;
    fn TextOutW(dc: Handle, x: i32, y: i32, text: *const u16, count: i32) -> i32;
    fn GdiFlush() -> i32;
}

fn valid(handle: Handle) -> bool {
    !handle.is_null() && handle as isize != -1
}

#[derive(Default)]
struct Canvas {
    dc: Handle,
    bitmap: Handle,
    font: Handle,
    previous_bitmap: Handle,
    previous_font: Handle,
}

impl Drop for Canvas {
    fn drop(&mut self) {
        // SAFETY: Every owned handle was created in this scope. Restore the
        // original selections before deleting the font/bitmap, including on
        // early failure. No handle or DIB pointer escapes rasterize().
        unsafe {
            if valid(self.previous_font) {
                SelectObject(self.dc, self.previous_font);
            }
            if valid(self.previous_bitmap) {
                SelectObject(self.dc, self.previous_bitmap);
            }
            if valid(self.font) {
                DeleteObject(self.font);
            }
            if valid(self.bitmap) {
                DeleteObject(self.bitmap);
            }
            if valid(self.dc) {
                DeleteDC(self.dc);
            }
        }
    }
}

/// Render white-on-black into a private top-down DIB, then crop by actual ink
/// bounds. Grayscale coverage (not ClearType RGB) avoids colored text fringes.
pub(super) fn rasterize(text: &str, em_pixels: u32, side: u32) -> Option<Mask> {
    if text.is_empty()
        || text.len() > 3
        || !text.bytes().all(|c| c.is_ascii_digit() || c == b'-')
        || !(32..=512).contains(&side)
        || em_pixels == 0
        || em_pixels > side / 2
    {
        return None;
    }
    let mut canvas = Canvas::default();
    let face: Vec<u16> = "Segoe UI".encode_utf16().chain(Some(0)).collect();
    let wide: Vec<u16> = text.encode_utf16().collect();
    let info = BitmapInfo {
        header: BitmapInfoHeader {
            size: std::mem::size_of::<BitmapInfoHeader>() as u32,
            width: side as i32,
            height: -(side as i32),
            planes: 1,
            bit_count: 32,
            compression: 0, // BI_RGB: four bytes per pixel; row stride = side*4.
            size_image: side * side * 4,
            x_pels_per_meter: 0,
            y_pels_per_meter: 0,
            clr_used: 0,
            clr_important: 0,
        },
        colors: [0],
    };
    let mut bits = ptr::null_mut();
    // SAFETY: The dimensions are bounded above. We initialize the complete DIB
    // before drawing, flush GDI before reading it, and copy its pixels before
    // Canvas drops. Each invocation owns a separate DC, bitmap and font.
    unsafe {
        canvas.dc = CreateCompatibleDC(ptr::null_mut());
        if !valid(canvas.dc) {
            return None;
        }
        canvas.bitmap = CreateDIBSection(canvas.dc, &info, 0, &mut bits, ptr::null_mut(), 0);
        if !valid(canvas.bitmap) || bits.is_null() {
            return None;
        }
        canvas.previous_bitmap = SelectObject(canvas.dc, canvas.bitmap);
        if !valid(canvas.previous_bitmap) {
            return None;
        }
        canvas.font = CreateFontW(
            -(em_pixels as i32),
            0,
            0,
            0,
            600,
            0,
            0,
            0,
            0,
            7,
            0,
            4,
            0,
            face.as_ptr(),
        );
        // 600=semibold, ANSI_CHARSET=0, OUT_TT_ONLY_PRECIS=7,
        // ANTIALIASED_QUALITY=4. Oversampling supplies the final smoothing.
        if !valid(canvas.font) {
            return None;
        }
        canvas.previous_font = SelectObject(canvas.dc, canvas.font);
        if !valid(canvas.previous_font) {
            return None;
        }
        ptr::write_bytes(bits.cast::<u8>(), 0, (side * side * 4) as usize);
        if SetTextColor(canvas.dc, 0x00ff_ffff) == 0xffff_ffff || SetBkMode(canvas.dc, 1) == 0 {
            return None;
        }
        if TextOutW(canvas.dc, 4, 4, wide.as_ptr(), wide.len() as i32) == 0 || GdiFlush() == 0 {
            return None;
        }
        let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), (side * side * 4) as usize);
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (side, side, 0, 0);
        for y in 0..side {
            for x in 0..side {
                if pixels[((y * side + x) * 4 + 1) as usize] > 0 {
                    min_x = min_x.min(x);
                    min_y = min_y.min(y);
                    max_x = max_x.max(x);
                    max_y = max_y.max(y);
                }
            }
        }
        if min_x == side || max_x >= side - 1 || max_y >= side - 1 {
            return None;
        }
        let width = max_x - min_x + 1;
        let height = max_y - min_y + 1;
        let mut alpha = Vec::with_capacity((width * height) as usize);
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                alpha.push(pixels[((y * side + x) * 4 + 1) as usize]);
            }
        }
        Some(Mask {
            width,
            height,
            alpha,
        })
    }
}
