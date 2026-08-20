use base64::{engine::general_purpose::STANDARD, Engine};
use ab_glyph::{FontArc, PxScale};
use arboard::{Clipboard, ImageData};
use chrono::Local;
use directories::UserDirs;
use fast_image_resize as fir;
use fast_image_resize::images::Image as FirImage;
use image::{DynamicImage, GenericImageView, ImageReader, Rgba, RgbaImage};
use imageproc::drawing::{draw_text_mut, text_size};
use png::{BitDepth, ColorType, Decoder, Encoder};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tracing::info;
use uuid::Uuid;
use crate::storage::{source::resolve_media_source, tos};

const STORYBOARD_METADATA_PNG_TEXT_KEY: &str = "StoryboardCopilotMetadata";
const FAST_PREVIEW_BYPASS_MAX_BYTES: usize = 2_000_000;
const FAST_PREVIEW_BYPASS_MAX_DIMENSION: u32 = 2048;
const GENERATED_IMAGE_RANDOM_SUFFIX_LENGTH: usize = 8;

fn normalize_generated_image_filename_segment(value: &str, fallback: &str) -> String {
    let mut normalized = String::new();
    let mut previous_character_was_separator = false;

    for character in value.trim().chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_') {
            normalized.push(character);
            previous_character_was_separator = false;
        } else if !normalized.is_empty() && !previous_character_was_separator {
            normalized.push('_');
            previous_character_was_separator = true;
        }
    }

    let normalized = normalized.trim_matches('_');
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized.to_string()
    }
}

fn build_generated_image_filename(
    provider_name: &str,
    model_name: &str,
    timestamp: &str,
    random_suffix: &str,
    extension: &str,
) -> String {
    let provider_segment = normalize_generated_image_filename_segment(provider_name, "generated");
    let model_segment = normalize_generated_image_filename_segment(model_name, "model");

    format!(
        "{}_{}_{}_{}.{}",
        provider_segment,
        model_segment,
        timestamp,
        random_suffix,
        normalize_extension(extension)
    )
}

fn generate_image_filename(
    provider_name: Option<&str>,
    model_name: Option<&str>,
    extension: &str,
) -> String {
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let random_id = Uuid::new_v4().simple().to_string();
    let random_suffix = &random_id[..GENERATED_IMAGE_RANDOM_SUFFIX_LENGTH];
    build_generated_image_filename(
        provider_name.unwrap_or_default(),
        model_name.unwrap_or_default(),
        &timestamp,
        random_suffix,
        extension,
    )
}

fn save_generated_image_bytes(
    outputs_dir: &Path,
    bytes: &[u8],
    provider_name: Option<&str>,
    model_name: Option<&str>,
) -> Result<PathBuf, String> {
    let image_format = image::guess_format(bytes)
        .map_err(|e| format!("Failed to identify generated image format: {}", e))?;
    let extension = image_format
        .extensions_str()
        .first()
        .ok_or_else(|| "Generated image format has no file extension".to_string())?;
    let filename = generate_image_filename(provider_name, model_name, extension);
    let output_path = outputs_dir.join(filename);
    std::fs::write(&output_path, bytes).map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(output_path)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardImageMetadata {
    pub grid_rows: u32,
    pub grid_cols: u32,
    pub frame_notes: Vec<String>,
}

#[tauri::command]
pub async fn split_image(
    image_base64: String,
    rows: u32,
    cols: u32,
    line_thickness: Option<u32>,
) -> Result<Vec<String>, String> {
    let safe_rows = rows.max(1);
    let safe_cols = cols.max(1);
    let requested_line = line_thickness.unwrap_or(0);

    info!(
        "Splitting image into {}x{}, line thickness={}",
        safe_rows, safe_cols, requested_line
    );

    let image_data = STANDARD
        .decode(&image_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let img =
        image::load_from_memory(&image_data).map_err(|e| format!("Failed to load image: {}", e))?;

    let (width, height) = img.dimensions();
    let resolved_line = resolve_line_thickness(width, height, safe_rows, safe_cols, requested_line);
    let usable_width = width.saturating_sub((safe_cols.saturating_sub(1)).saturating_mul(resolved_line));
    let usable_height = height.saturating_sub((safe_rows.saturating_sub(1)).saturating_mul(resolved_line));

    if usable_width < safe_cols || usable_height < safe_rows {
        return Err("分割线过粗，无法完成切割".to_string());
    }

    let column_widths = split_sizes(usable_width, safe_cols);
    let row_heights = split_sizes(usable_height, safe_rows);

    let mut x_offsets = Vec::with_capacity(safe_cols as usize);
    let mut cursor_x = 0_u32;
    for col in 0..safe_cols {
        x_offsets.push(cursor_x);
        cursor_x = cursor_x.saturating_add(column_widths[col as usize]);
        if col < safe_cols - 1 {
            cursor_x = cursor_x.saturating_add(resolved_line);
        }
    }

    let mut y_offsets = Vec::with_capacity(safe_rows as usize);
    let mut cursor_y = 0_u32;
    for row in 0..safe_rows {
        y_offsets.push(cursor_y);
        cursor_y = cursor_y.saturating_add(row_heights[row as usize]);
        if row < safe_rows - 1 {
            cursor_y = cursor_y.saturating_add(resolved_line);
        }
    }

    let mut results = Vec::new();

    for row in 0..safe_rows {
        for col in 0..safe_cols {
            let x = x_offsets[col as usize];
            let y = y_offsets[row as usize];
            let width = column_widths[col as usize];
            let height = row_heights[row as usize];

            let cropped = img.crop_imm(x, y, width, height);

            let mut buffer = Cursor::new(Vec::new());
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 90);
            cropped
                .write_with_encoder(encoder)
                .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

            let base64_data = STANDARD.encode(buffer.get_ref());
            results.push(format!("data:image/jpeg;base64,{}", base64_data));
        }
    }

    info!("Split into {} images", results.len());
    Ok(results)
}

#[tauri::command]
pub async fn split_image_source(
    app: AppHandle,
    source: String,
    rows: u32,
    cols: u32,
    line_thickness: Option<u32>,
    project_id: Option<String>,
) -> Result<Vec<String>, String> {
    let started = Instant::now();
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_rows = rows.max(1);
    let safe_cols = cols.max(1);
    let requested_line = line_thickness.unwrap_or(0);

    info!(
        "Splitting source image into {}x{}, line thickness={}, project_id={:?}",
        safe_rows, safe_cols, requested_line, project_id
    );

    let (source_bytes, _source_ext) = resolve_source_bytes(trimmed_source).await?;
    let decode_done = Instant::now();
    let image = image::load_from_memory(&source_bytes)
        .map_err(|e| format!("Failed to decode source image: {}", e))?;

    let (width, height) = image.dimensions();
    let resolved_line = resolve_line_thickness(width, height, safe_rows, safe_cols, requested_line);
    let usable_width = width.saturating_sub((safe_cols.saturating_sub(1)).saturating_mul(resolved_line));
    let usable_height = height.saturating_sub((safe_rows.saturating_sub(1)).saturating_mul(resolved_line));

    if usable_width < safe_cols || usable_height < safe_rows {
        return Err("分割线过粗，无法完成切割".to_string());
    }

    let column_widths = split_sizes(usable_width, safe_cols);
    let row_heights = split_sizes(usable_height, safe_rows);

    let mut x_offsets = Vec::with_capacity(safe_cols as usize);
    let mut cursor_x = 0_u32;
    for col in 0..safe_cols {
        x_offsets.push(cursor_x);
        cursor_x = cursor_x.saturating_add(column_widths[col as usize]);
        if col < safe_cols - 1 {
            cursor_x = cursor_x.saturating_add(resolved_line);
        }
    }

    let mut y_offsets = Vec::with_capacity(safe_rows as usize);
    let mut cursor_y = 0_u32;
    for row in 0..safe_rows {
        y_offsets.push(cursor_y);
        cursor_y = cursor_y.saturating_add(row_heights[row as usize]);
        if row < safe_rows - 1 {
            cursor_y = cursor_y.saturating_add(resolved_line);
        }
    }

    let mut results = Vec::with_capacity((safe_rows * safe_cols) as usize);

    for row in 0..safe_rows {
        for col in 0..safe_cols {
            let x = x_offsets[col as usize];
            let y = y_offsets[row as usize];
            let width = column_widths[col as usize];
            let height = row_heights[row as usize];
            let cropped = image.crop_imm(x, y, width, height);

            let mut buffer = Cursor::new(Vec::new());
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 90);
            cropped
                .write_with_encoder(encoder)
                .map_err(|e| format!("Failed to encode split image: {}", e))?;

            let persisted = persist_image_bytes(&app, buffer.get_ref(), "jpg", project_id.as_deref())?;
            results.push(persisted);
        }
    }

    info!(
        "split_image_source done: {} frames, decode={}ms, total={}ms",
        results.len(),
        decode_done.duration_since(started).as_millis(),
        started.elapsed().as_millis()
    );

    Ok(results)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStoryboardImagesPayload {
    pub frame_sources: Vec<String>,
    pub rows: u32,
    pub cols: u32,
    pub cell_gap: u32,
    pub outer_padding: u32,
    pub note_height: u32,
    pub font_size: u32,
    pub background_color: String,
    pub max_dimension: u32,
    pub show_frame_index: Option<bool>,
    pub show_frame_note: Option<bool>,
    pub note_placement: Option<String>,
    pub image_fit: Option<String>,
    pub frame_index_prefix: Option<String>,
    pub text_color: Option<String>,
    pub frame_notes: Option<Vec<String>>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStoryboardImagesResult {
    pub image_path: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub gap: u32,
    pub padding: u32,
    pub note_height: u32,
    pub font_size: u32,
    pub text_overlay_applied: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareNodeImageResult {
    pub image_path: String,
    pub preview_image_path: String,
    pub aspect_ratio: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImagePreviewResult {
    pub preview_image_path: String,
    pub aspect_ratio: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropImageSourcePayload {
    pub source: String,
    pub aspect_ratio: Option<String>,
    pub crop_x: Option<f64>,
    pub crop_y: Option<f64>,
    pub crop_width: Option<f64>,
    pub crop_height: Option<f64>,
    pub project_id: Option<String>,
}

fn split_sizes(total: u32, segments: u32) -> Vec<u32> {
    let safe_segments = segments.max(1);
    let base = total / safe_segments;
    let remainder = total % safe_segments;

    (0..safe_segments)
        .map(|index| base + if index < remainder { 1 } else { 0 })
        .collect()
}

fn gcd_u32(a: u32, b: u32) -> u32 {
    let mut x = a.max(1);
    let mut y = b.max(1);

    while y != 0 {
        let temp = y;
        y = x % y;
        x = temp;
    }

    x.max(1)
}

fn reduce_aspect_ratio(width: u32, height: u32) -> String {
    let safe_width = width.max(1);
    let safe_height = height.max(1);
    let gcd = gcd_u32(safe_width, safe_height);
    format!("{}:{}", safe_width / gcd, safe_height / gcd)
}

fn parse_aspect_ratio(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("free") || trimmed.is_empty() {
        return None;
    }

    let (w, h) = trimmed.split_once(':')?;
    let width = w.trim().parse::<f64>().ok()?;
    let height = h.trim().parse::<f64>().ok()?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }

    Some(width / height)
}

fn resolve_line_thickness(
    image_width: u32,
    image_height: u32,
    rows: u32,
    cols: u32,
    line_thickness: u32,
) -> u32 {
    if line_thickness == 0 {
        return 0;
    }

    let max_by_width = if cols > 1 {
        image_width.saturating_sub(cols) / (cols - 1)
    } else {
        line_thickness
    };
    let max_by_height = if rows > 1 {
        image_height.saturating_sub(rows) / (rows - 1)
    } else {
        line_thickness
    };
    line_thickness.min(max_by_width.min(max_by_height))
}

fn parse_hex_color(color: &str) -> Rgba<u8> {
    let value = color.trim().trim_start_matches('#');
    let parse_pair = |start: usize| -> Option<u8> {
        u8::from_str_radix(value.get(start..start + 2)?, 16).ok()
    };

    match value.len() {
        6 => {
            let (Some(r), Some(g), Some(b)) = (parse_pair(0), parse_pair(2), parse_pair(4)) else {
                return Rgba([15, 17, 21, 255]);
            };
            Rgba([r, g, b, 255])
        }
        8 => {
            let (Some(r), Some(g), Some(b), Some(a)) = (
                parse_pair(0),
                parse_pair(2),
                parse_pair(4),
                parse_pair(6),
            ) else {
                return Rgba([15, 17, 21, 255]);
            };
            Rgba([r, g, b, a])
        }
        _ => Rgba([15, 17, 21, 255]),
    }
}

static OVERLAY_FONT: OnceLock<Option<FontArc>> = OnceLock::new();

fn load_overlay_font() -> Option<&'static FontArc> {
    OVERLAY_FONT
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            let candidate_paths = [
                // Prefer Microsoft YaHei for CJK readability.
                "C:\\Windows\\Fonts\\msyh.ttc",
                "C:\\Windows\\Fonts\\msyhbd.ttc",
                "C:\\Windows\\Fonts\\msyhl.ttc",
                "C:\\Windows\\Fonts\\simhei.ttf",
                // Fallback Latin fonts.
                "C:\\Windows\\Fonts\\segoeui.ttf",
                "C:\\Windows\\Fonts\\arial.ttf",
            ];

            #[cfg(target_os = "macos")]
            let candidate_paths = [
                // Prefer PingFang for CJK readability.
                "/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/Hiragino Sans GB.ttc",
                "/System/Library/Fonts/STHeiti Medium.ttc",
                // Fallback.
                "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                "/System/Library/Fonts/Supplemental/Arial.ttf",
            ];

            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let candidate_paths = [
                "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ];

            for path in candidate_paths {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(font) = FontArc::try_from_vec(bytes) {
                        info!("Loaded storyboard overlay font from {}", path);
                        return Some(font);
                    }
                }
            }

            info!("No suitable system font found for storyboard text overlay");
            None
        })
        .as_ref()
}

fn trim_text_to_width(font: &FontArc, scale: PxScale, text: &str, max_width: u32) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let safe_text = normalized.trim();
    if safe_text.is_empty() {
        return String::new();
    }

    if text_size(scale, font, safe_text).0 <= max_width {
        return safe_text.to_string();
    }

    let mut content = safe_text.to_string();
    while content.chars().count() > 1 {
        content.pop();
        let with_ellipsis = format!("{}...", content);
        if text_size(scale, font, &with_ellipsis).0 <= max_width {
            return with_ellipsis;
        }
    }

    "...".to_string()
}

fn fill_rect(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: Rgba<u8>) {
    if width == 0 || height == 0 {
        return;
    }

    let max_x = (x.saturating_add(width)).min(image.width());
    let max_y = (y.saturating_add(height)).min(image.height());

    for yy in y..max_y {
        for xx in x..max_x {
            image.put_pixel(xx, yy, color);
        }
    }
}

fn blend_pixel(bottom: Rgba<u8>, top: Rgba<u8>) -> Rgba<u8> {
    let top_a = top[3] as u16;
    if top_a == 0 {
        return bottom;
    }
    if top_a == 255 {
        return top;
    }

    let bottom_a = bottom[3] as u16;
    let inv_top_a = 255_u16.saturating_sub(top_a);

    let out_a = top_a + (bottom_a * inv_top_a + 127) / 255;
    if out_a == 0 {
        return Rgba([0, 0, 0, 0]);
    }

    let blend_channel = |bottom_c: u8, top_c: u8| -> u8 {
        let bottom_premul = bottom_c as u32 * bottom_a as u32;
        let top_premul = top_c as u32 * top_a as u32;
        let out_premul = top_premul + ((bottom_premul * inv_top_a as u32 + 127) / 255);
        let out = (out_premul + (out_a as u32 / 2)) / out_a as u32;
        out.min(255) as u8
    };

    Rgba([
        blend_channel(bottom[0], top[0]),
        blend_channel(bottom[1], top[1]),
        blend_channel(bottom[2], top[2]),
        out_a as u8,
    ])
}

fn fill_rect_alpha_blend(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: Rgba<u8>,
) {
    if width == 0 || height == 0 {
        return;
    }

    let max_x = (x.saturating_add(width)).min(image.width());
    let max_y = (y.saturating_add(height)).min(image.height());

    for yy in y..max_y {
        for xx in x..max_x {
            let current = *image.get_pixel(xx, yy);
            image.put_pixel(xx, yy, blend_pixel(current, color));
        }
    }
}

fn stroke_right_edge(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: Rgba<u8>) {
    if width < 1 || height < 1 {
        return;
    }

    let x2 = x.saturating_add(width.saturating_sub(1));
    if x2 >= image.width() {
        return;
    }

    let max_y = y.saturating_add(height).min(image.height());
    for yy in y..max_y {
        if yy < image.height() {
            image.put_pixel(x2, yy, color);
        }
    }
}

fn stroke_bottom_edge(image: &mut RgbaImage, x: u32, y: u32, width: u32, height: u32, color: Rgba<u8>) {
    if width < 1 || height < 1 {
        return;
    }

    let y2 = y.saturating_add(height.saturating_sub(1));
    if y2 >= image.height() {
        return;
    }

    let max_x = x.saturating_add(width).min(image.width());
    for xx in x..max_x {
        if xx < image.width() {
            image.put_pixel(xx, y2, color);
        }
    }
}

fn resize_image_fast(source: &DynamicImage, target_width: u32, target_height: u32) -> Result<RgbaImage, String> {
    let source_rgba = source.to_rgba8();
    let source_width = source_rgba.width().max(1);
    let source_height = source_rgba.height().max(1);
    let source_pixels = source_rgba.into_raw();

    let source_image = FirImage::from_vec_u8(
        source_width,
        source_height,
        source_pixels,
        fir::PixelType::U8x4,
    )
    .map_err(|e| format!("Failed to create source image for fast resize: {}", e))?;
    let mut target_image =
        FirImage::new(target_width.max(1), target_height.max(1), fir::PixelType::U8x4);

    let mut resizer = fir::Resizer::new();
    let resize_options =
        fir::ResizeOptions::new().resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::Bilinear));
    resizer
        .resize(&source_image, &mut target_image, Some(&resize_options))
        .map_err(|e| format!("Failed to run fast image resize: {}", e))?;

    RgbaImage::from_raw(target_width.max(1), target_height.max(1), target_image.into_vec())
        .ok_or_else(|| "Failed to build RGBA image from resized buffer".to_string())
}

async fn load_dynamic_image_from_source(source: &str) -> Result<DynamicImage, String> {
    let (bytes, _extension) = resolve_source_bytes(source).await?;
    image::load_from_memory(&bytes).map_err(|e| format!("Failed to decode image source: {}", e))
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn prepare_node_image_from_bytes(
    app: &AppHandle,
    bytes: &[u8],
    extension: &str,
    safe_max_dimension: u32,
    trace_tag: &str,
    project_id: Option<&str>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    let probe_started = Instant::now();
    let (raw_width, raw_height) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to guess image format: {}", e))?
        .into_dimensions()
        .map_err(|e| format!("Failed to parse image dimensions: {}", e))?;
    let probe_elapsed = probe_started.elapsed().as_millis();
    let width = raw_width.max(1);
    let height = raw_height.max(1);

    let persist_started = Instant::now();
    // Decode and re-encode as JPEG for uniform format
    let image = image::load_from_memory(bytes)
        .map_err(|e| format!("Failed to decode image: {}", e))?;
    let mut jpeg_buffer = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buffer, 90);
    image
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
    let image_path = persist_image_bytes(app, jpeg_buffer.get_ref(), "jpg", project_id)?;
    let persist_elapsed = persist_started.elapsed().as_millis();
    let longest_side = width.max(height);
    let bypass_preview = longest_side <= safe_max_dimension
        || (bytes.len() <= FAST_PREVIEW_BYPASS_MAX_BYTES
            && longest_side <= FAST_PREVIEW_BYPASS_MAX_DIMENSION);
    if bypass_preview {
        info!(
            "prepare_node_image done [{}]: bytes={}, ext={}, size={}x{}, max_preview={}, probe={}ms, decode=0ms, persist_original={}ms, resize=0ms, bypass_preview=true, total={}ms",
            trace_tag,
            bytes.len(),
            extension,
            width,
            height,
            safe_max_dimension,
            probe_elapsed,
            persist_elapsed,
            started.elapsed().as_millis()
        );
        return Ok(PrepareNodeImageResult {
            image_path: image_path.clone(),
            preview_image_path: image_path,
            aspect_ratio: reduce_aspect_ratio(width, height),
        });
    }

    // Reuse the already-decoded image for preview generation
    let decode_elapsed = 0i32; // Already decoded above
    let resize_started = Instant::now();
    let scale = safe_max_dimension as f64 / longest_side as f64;
    let target_width = ((width as f64) * scale).round().max(1.0) as u32;
    let target_height = ((height as f64) * scale).round().max(1.0) as u32;
    let resized_rgba = resize_image_fast(&image, target_width, target_height)
        .unwrap_or_else(|_| {
            image
                .resize(target_width, target_height, image::imageops::FilterType::Triangle)
                .to_rgba8()
        });
    let resized = DynamicImage::ImageRgba8(resized_rgba);

    let mut preview_buffer = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut preview_buffer, 90);
    resized
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode preview image: {}", e))?;
    let preview_image_path = persist_image_bytes(app, preview_buffer.get_ref(), "jpg", project_id)?;
    let resize_elapsed = resize_started.elapsed().as_millis();

    info!(
        "prepare_node_image done [{}]: bytes={}, ext={}, size={}x{}, max_preview={}, probe={}ms, decode={}ms, persist_original={}ms, resize={}ms, total={}ms",
        trace_tag,
        bytes.len(),
        extension,
        width,
        height,
        safe_max_dimension,
        probe_elapsed,
        decode_elapsed,
        persist_elapsed,
        resize_elapsed,
        started.elapsed().as_millis()
    );

    Ok(PrepareNodeImageResult {
        image_path,
        preview_image_path,
        aspect_ratio: reduce_aspect_ratio(width, height),
    })
}

#[tauri::command]
pub async fn prepare_node_image_source(
    app: AppHandle,
    source: String,
    max_preview_dimension: Option<u32>,
    project_id: Option<String>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let resolve_started = Instant::now();
    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    let resolve_elapsed = resolve_started.elapsed().as_millis();
    let result = prepare_node_image_from_bytes(
        &app,
        &bytes,
        &extension,
        safe_max_dimension,
        "source",
        project_id.as_deref(),
    )?;
    info!(
        "prepare_node_image_source resolved: bytes={}, ext={}, resolve_source={}ms, total={}ms",
        bytes.len(),
        extension,
        resolve_elapsed,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn prepare_node_image_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: Option<String>,
    max_preview_dimension: Option<u32>,
    project_id: Option<String>,
) -> Result<PrepareNodeImageResult, String> {
    let started = Instant::now();
    if bytes.is_empty() {
        return Err("Image bytes are empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let resolved_extension = extension
        .as_deref()
        .map(normalize_extension)
        .unwrap_or_else(|| "jpg".to_string());

    let result = prepare_node_image_from_bytes(
        &app,
        &bytes,
        &resolved_extension,
        safe_max_dimension,
        "binary",
        project_id.as_deref(),
    )?;
    info!(
        "prepare_node_image_binary resolved: bytes={}, ext={}, total={}ms",
        bytes.len(),
        resolved_extension,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn create_image_preview(
    app: AppHandle,
    source: String,
    max_preview_dimension: Option<u32>,
    project_id: Option<String>,
) -> Result<CreateImagePreviewResult, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let safe_max_dimension = max_preview_dimension.unwrap_or(512).clamp(64, 4096);
    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;
    let (raw_width, raw_height) = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to guess image format: {}", e))?
        .into_dimensions()
        .map_err(|e| format!("Failed to parse image dimensions: {}", e))?;
    let width = raw_width.max(1);
    let height = raw_height.max(1);
    let aspect_ratio = reduce_aspect_ratio(width, height);

    if width.max(height) <= safe_max_dimension {
        return Ok(CreateImagePreviewResult {
            preview_image_path: trimmed.to_string(),
            aspect_ratio,
        });
    }

    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image: {}", e))?;
    let scale = safe_max_dimension as f64 / width.max(height) as f64;
    let target_width = ((width as f64) * scale).round().max(1.0) as u32;
    let target_height = ((height as f64) * scale).round().max(1.0) as u32;
    let resized_rgba = resize_image_fast(&image, target_width, target_height)
        .unwrap_or_else(|_| {
            image
                .resize(target_width, target_height, image::imageops::FilterType::Triangle)
                .to_rgba8()
        });
    let resized = DynamicImage::ImageRgba8(resized_rgba);
    let mut preview_buffer = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut preview_buffer, 90);
    resized
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode preview image: {}", e))?;
    let preview_image_path = persist_image_bytes(
        &app,
        preview_buffer.get_ref(),
        "jpg",
        project_id.as_deref(),
    )?;

    Ok(CreateImagePreviewResult {
        preview_image_path,
        aspect_ratio,
    })
}

#[tauri::command]
pub async fn crop_image_source(
    app: AppHandle,
    payload: CropImageSourcePayload,
) -> Result<String, String> {
    let trimmed = payload.source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let source_image = load_dynamic_image_from_source(trimmed).await?;
    let source_width = source_image.width() as f64;
    let source_height = source_image.height() as f64;

    let crop_x = payload.crop_x.unwrap_or(f64::NAN);
    let crop_y = payload.crop_y.unwrap_or(f64::NAN);
    let crop_width_option = payload.crop_width.unwrap_or(f64::NAN);
    let crop_height_option = payload.crop_height.unwrap_or(f64::NAN);
    let has_manual_crop = crop_x.is_finite()
        && crop_y.is_finite()
        && crop_width_option.is_finite()
        && crop_height_option.is_finite()
        && crop_width_option > 0.0
        && crop_height_option > 0.0;

    let aspect_ratio = payload
        .aspect_ratio
        .as_deref()
        .unwrap_or("1:1")
        .trim()
        .to_string();
    let target_ratio = parse_aspect_ratio(&aspect_ratio);

    let (offset_x, offset_y, crop_width, crop_height) = if has_manual_crop {
        let safe_x = clamp_f64(crop_x.floor(), 0.0, (source_width - 1.0).max(0.0));
        let safe_y = clamp_f64(crop_y.floor(), 0.0, (source_height - 1.0).max(0.0));
        let safe_width = clamp_f64(crop_width_option.floor(), 1.0, source_width - safe_x);
        let safe_height = clamp_f64(crop_height_option.floor(), 1.0, source_height - safe_y);
        (safe_x, safe_y, safe_width, safe_height)
    } else if aspect_ratio.eq_ignore_ascii_case("free") {
        (0.0, 0.0, source_width, source_height)
    } else if let Some(ratio) = target_ratio {
        let source_ratio = source_width / source_height;
        if source_ratio > ratio {
            let width = source_height * ratio;
            ((source_width - width) / 2.0, 0.0, width, source_height)
        } else {
            let height = source_width / ratio;
            (0.0, (source_height - height) / 2.0, source_width, height)
        }
    } else {
        (0.0, 0.0, source_width, source_height)
    };

    let final_x = offset_x.floor().max(0.0) as u32;
    let final_y = offset_y.floor().max(0.0) as u32;
    let max_crop_width = source_image.width().saturating_sub(final_x).max(1);
    let max_crop_height = source_image.height().saturating_sub(final_y).max(1);
    let final_width = (crop_width.floor().max(1.0) as u32).min(max_crop_width);
    let final_height = (crop_height.floor().max(1.0) as u32).min(max_crop_height);

    let cropped = source_image.crop_imm(final_x, final_y, final_width, final_height);
    let mut buffer = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 90);
    cropped
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

    persist_image_bytes(&app, buffer.get_ref(), "jpg", payload.project_id.as_deref())
}

#[tauri::command]
pub async fn merge_storyboard_images(
    app: AppHandle,
    payload: MergeStoryboardImagesPayload,
) -> Result<MergeStoryboardImagesResult, String> {
    let started = Instant::now();
    let rows = payload.rows.max(1);
    let cols = payload.cols.max(1);
    let total_cells = rows.saturating_mul(cols) as usize;

    let mut frames: Vec<Option<DynamicImage>> = Vec::with_capacity(total_cells);
    let mut reference_size: Option<(u32, u32)> = None;

    for index in 0..total_cells {
        let source = payload
            .frame_sources
            .get(index)
            .map(|value| value.trim())
            .unwrap_or("");

        if source.is_empty() {
            frames.push(None);
            continue;
        }

        match load_dynamic_image_from_source(source).await {
            Ok(image) => {
                if reference_size.is_none() {
                    reference_size = Some((image.width().max(1), image.height().max(1)));
                }
                frames.push(Some(image));
            }
            Err(_) => {
                frames.push(None);
            }
        }
    }
    let load_done = Instant::now();

    let (source_cell_width, source_cell_height) =
        reference_size.ok_or_else(|| "没有可导出的图片".to_string())?;

    let raw_gap = payload.cell_gap.min(240);
    let raw_padding = payload.outer_padding.min(360);
    let raw_note_height = payload.note_height.min(360);
    let raw_font_size = payload.font_size.clamp(10, 240);
    let max_dimension = payload.max_dimension.clamp(1024, 8192);
    let show_frame_index = payload.show_frame_index.unwrap_or(false);
    let show_frame_note = payload.show_frame_note.unwrap_or(false);
    let note_placement = payload
        .note_placement
        .as_deref()
        .unwrap_or("overlay")
        .to_ascii_lowercase();
    let image_fit = payload
        .image_fit
        .as_deref()
        .unwrap_or("cover")
        .to_ascii_lowercase();
    let use_cover_fit = image_fit != "contain";
    let frame_index_prefix = payload
        .frame_index_prefix
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("S")
        .to_string();
    let text_color = parse_hex_color(payload.text_color.as_deref().unwrap_or("#f8fafc"));
    let frame_notes = payload.frame_notes.unwrap_or_default();
    let overlay_requested = show_frame_index || show_frame_note;

    let raw_output_width = raw_padding as u64 * 2
        + cols as u64 * source_cell_width as u64
        + cols.saturating_sub(1) as u64 * raw_gap as u64;
    let raw_output_height = raw_padding as u64 * 2
        + rows as u64 * (source_cell_height as u64 + raw_note_height as u64)
        + rows.saturating_sub(1) as u64 * raw_gap as u64;

    let longest_side = raw_output_width.max(raw_output_height).max(1) as f64;
    let scale = (max_dimension as f64 / longest_side).min(1.0);

    let cell_width = ((source_cell_width as f64) * scale).round().max(8.0) as u32;
    let cell_height = ((source_cell_height as f64) * scale).round().max(8.0) as u32;
    let gap = ((raw_gap as f64) * scale).round().max(0.0) as u32;
    let padding = ((raw_padding as f64) * scale).round().max(0.0) as u32;
    let note_height = ((raw_note_height as f64) * scale).round().max(0.0) as u32;
    let font_size = ((raw_font_size as f64) * scale).round().max(9.0) as u32;

    let output_width = padding.saturating_mul(2)
        + cols.saturating_mul(cell_width)
        + cols.saturating_sub(1).saturating_mul(gap);
    let output_height = padding.saturating_mul(2)
        + rows.saturating_mul(cell_height.saturating_add(note_height))
        + rows.saturating_sub(1).saturating_mul(gap);

    let mut canvas = RgbaImage::from_pixel(
        output_width.max(1),
        output_height.max(1),
        parse_hex_color(&payload.background_color),
    );
    let placeholder = Rgba([0, 0, 0, 90]);
    let border = Rgba([255, 255, 255, 56]);
    let overlay_font = if overlay_requested { load_overlay_font() } else { None };
    let overlay_scale = PxScale::from(font_size.max(9) as f32);
    let text_overlay_applied = !overlay_requested || overlay_font.is_some();

    for index in 0..total_cells {
        let row = (index as u32) / cols;
        let col = (index as u32) % cols;
        let x = padding + col.saturating_mul(cell_width.saturating_add(gap));
        let y = padding + row.saturating_mul(cell_height.saturating_add(note_height).saturating_add(gap));

        fill_rect(&mut canvas, x, y, cell_width, cell_height, placeholder);

        if let Some(frame) = frames.get(index).and_then(|item| item.as_ref()) {
            let src_w = frame.width().max(1) as f64;
            let src_h = frame.height().max(1) as f64;
            let ratio = if use_cover_fit {
                ((cell_width as f64) / src_w).max((cell_height as f64) / src_h)
            } else {
                ((cell_width as f64) / src_w).min((cell_height as f64) / src_h)
            };
            let draw_w = (src_w * ratio).round().max(1.0) as u32;
            let draw_h = (src_h * ratio).round().max(1.0) as u32;

            let mut cell_canvas = RgbaImage::from_pixel(cell_width.max(1), cell_height.max(1), placeholder);
            let draw_x = (cell_width as i64 - draw_w as i64) / 2;
            let draw_y = (cell_height as i64 - draw_h as i64) / 2;

            if draw_w == frame.width() && draw_h == frame.height() {
                image::imageops::overlay(&mut cell_canvas, &frame.to_rgba8(), draw_x, draw_y);
            } else if let Ok(resized_rgba) = resize_image_fast(frame, draw_w, draw_h) {
                image::imageops::overlay(&mut cell_canvas, &resized_rgba, draw_x, draw_y);
            } else {
                // Fallback path keeps behavior correct if SIMD resize fails for unexpected input.
                let resized = frame.resize(draw_w, draw_h, image::imageops::FilterType::Triangle);
                image::imageops::overlay(&mut cell_canvas, &resized.to_rgba8(), draw_x, draw_y);
            }

            image::imageops::overlay(&mut canvas, &cell_canvas, x as i64, y as i64);
        }

        // Keep only internal split lines; do not draw an outer frame around the whole storyboard.
        if col < cols.saturating_sub(1) {
            stroke_right_edge(&mut canvas, x, y, cell_width, cell_height, border);
        }
        if row < rows.saturating_sub(1) {
            stroke_bottom_edge(&mut canvas, x, y, cell_width, cell_height, border);
        }

        if let Some(font) = overlay_font {
            if show_frame_index {
                let label = format!("{}{}", frame_index_prefix, index + 1);
                let (label_w, label_h) = text_size(overlay_scale, font, &label);
                let badge_padding_x = (font_size as f32 * 0.35).round().max(6.0) as u32;
                let badge_height = (font_size as f32 * 1.15).round().max(18.0) as u32;
                let badge_width = label_w.saturating_add(badge_padding_x.saturating_mul(2));
                let badge_x = x.saturating_add(6);
                let badge_y = y.saturating_add(6);

                fill_rect_alpha_blend(
                    &mut canvas,
                    badge_x,
                    badge_y,
                    badge_width,
                    badge_height,
                    Rgba([0, 0, 0, 166]),
                );

                let text_x = badge_x.saturating_add(badge_padding_x) as i32;
                let text_y = badge_y
                    .saturating_add(badge_height.saturating_sub(label_h) / 2)
                    .max(0) as i32;
                draw_text_mut(&mut canvas, text_color, text_x, text_y, overlay_scale, font, &label);
            }

            if show_frame_note {
                let note_raw = frame_notes
                    .get(index)
                    .map(|value| value.trim())
                    .unwrap_or("");
                if !note_raw.is_empty() {
                    let note = trim_text_to_width(font, overlay_scale, note_raw, cell_width.saturating_sub(14));
                    if !note.is_empty() {
                        let (note_w, note_h) = text_size(overlay_scale, font, &note);
                        if note_placement == "bottom" && note_height > 0 {
                            let note_x = x.saturating_add(4) as i32;
                            let note_y = y
                                .saturating_add(cell_height)
                                .saturating_add(note_height.saturating_sub(note_h) / 2)
                                .max(0) as i32;
                            let _ = note_w;
                            draw_text_mut(&mut canvas, text_color, note_x, note_y, overlay_scale, font, &note);
                        } else {
                            let overlay_height = (font_size as f32 * 1.35).round().max(18.0) as u32;
                            let overlay_y = y
                                .saturating_add(cell_height)
                                .saturating_sub(overlay_height);
                            fill_rect_alpha_blend(
                                &mut canvas,
                                x,
                                overlay_y,
                                cell_width,
                                overlay_height,
                                Rgba([0, 0, 0, 153]),
                            );
                            let note_x = x.saturating_add(7) as i32;
                            let note_y = overlay_y
                                .saturating_add(overlay_height.saturating_sub(note_h) / 2)
                                .max(0) as i32;
                            draw_text_mut(&mut canvas, text_color, note_x, note_y, overlay_scale, font, &note);
                        }
                    }
                }
            }
        }
    }

    let mut buffer = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 90);
    DynamicImage::ImageRgba8(canvas)
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode merged storyboard image: {}", e))?;

    let image_path = persist_image_bytes(&app, buffer.get_ref(), "jpg", payload.project_id.as_deref())?;
    info!(
        "merge_storyboard_images done: {} cells, load={}ms, total={}ms, text_overlay_applied={}",
        total_cells,
        load_done.duration_since(started).as_millis(),
        started.elapsed().as_millis(),
        text_overlay_applied
    );

    Ok(MergeStoryboardImagesResult {
        image_path,
        canvas_width: output_width.max(1),
        canvas_height: output_height.max(1),
        cell_width,
        cell_height,
        gap,
        padding,
        note_height,
        font_size,
        text_overlay_applied,
    })
}

/// Resolve a directory path under {appDataDir}/projects/{project_id}/{subdir}.
/// subdir examples: "uploads", "outputs/images", "outputs/videos"
fn resolve_project_dir(app: &AppHandle, project_id: &str, subdir: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    let dir = app_data_dir
        .join("projects")
        .join(project_id)
        .join(subdir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create directory {}: {}", dir.display(), e))?;

    Ok(dir)
}

fn persist_image_bytes(app: &AppHandle, bytes: &[u8], extension: &str, project_id: Option<&str>) -> Result<String, String> {
    let dir = if let Some(pid) = project_id {
        resolve_project_dir(app, pid, "uploads")?
    } else {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
        let dir = app_data_dir.join("images");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create images dir: {}", e))?;
        dir
    };
    // 使用时间戳+进程ID+原子计数器确保唯一性，避免哈希碰撞导致文件被覆盖
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let process_id = std::process::id() as u64;
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let filename = format!("img_{}_{}_{}.{}", timestamp, process_id, counter, normalize_extension(extension));
    let output_path = dir.join(&filename);

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to persist generated image: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

fn normalize_extension(raw_ext: &str) -> String {
    let ext = raw_ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ext.is_empty() {
        return "jpg".to_string();
    }

    if ext == "jpeg" {
        return "jpg".to_string();
    }

    ext
}

fn extension_from_mime(mime: &str) -> String {
    let normalized = mime.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "image/png" => "png".to_string(),
        "image/jpeg" => "jpg".to_string(),
        "image/jpg" => "jpg".to_string(),
        "image/webp" => "webp".to_string(),
        "image/gif" => "gif".to_string(),
        "image/bmp" => "bmp".to_string(),
        "image/avif" => "avif".to_string(),
        _ => "png".to_string(),
    }
}

fn extension_from_path_like(value: &str) -> Option<String> {
    let cleaned = value
        .split('#')
        .next()
        .unwrap_or(value)
        .split('?')
        .next()
        .unwrap_or(value);
    let ext = Path::new(cleaned)
        .extension()
        .and_then(|item| item.to_str())
        .map(normalize_extension)?;

    Some(ext)
}

fn decode_file_url_path(value: &str) -> String {
    let raw = value.trim_start_matches("file://");
    let decoded = urlencoding::decode(raw)
        .map(|result| result.into_owned())
        .unwrap_or_else(|_| raw.to_string());

    if cfg!(target_os = "windows")
        && decoded.starts_with('/')
        && decoded.len() > 2
        && decoded.as_bytes().get(2) == Some(&b':')
    {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

fn decode_asset_url_path(value: &str) -> Result<PathBuf, String> {
    let path_part = value
        .strip_prefix("asset://localhost/")
        .or_else(|| value.strip_prefix("asset:///"))
        .ok_or_else(|| format!("Invalid asset URL format: {}", value))?;
    let decoded = urlencoding::decode(path_part)
        .map_err(|e| format!("URL decode failed: {}", e))?;
    let path = if cfg!(target_os = "windows") {
        decoded.trim_start_matches('/').to_string()
    } else if decoded.starts_with('/') {
        decoded.into_owned()
    } else {
        format!("/{}", decoded)
    };

    Ok(PathBuf::from(path))
}

fn parse_data_url(source: &str) -> Result<(Vec<u8>, String), String> {
    let (meta, payload) = source
        .split_once(',')
        .ok_or_else(|| "Invalid data URL format".to_string())?;

    if !meta.starts_with("data:") || !meta.ends_with(";base64") {
        return Err("Only base64 data URL is supported".to_string());
    }

    let mime = meta
        .strip_prefix("data:")
        .and_then(|v| v.strip_suffix(";base64"))
        .unwrap_or("image/png");

    let bytes = STANDARD
        .decode(payload)
        .map_err(|e| format!("Failed to decode data URL: {}", e))?;

    Ok((bytes, extension_from_mime(mime)))
}

fn read_storyboard_metadata_from_png_bytes(bytes: &[u8]) -> Result<Option<StoryboardImageMetadata>, String> {
    let decoder = Decoder::new(Cursor::new(bytes));
    let reader = decoder
        .read_info()
        .map_err(|e| format!("Failed to decode PNG metadata: {}", e))?;
    let info = reader.info();

    for text_chunk in &info.uncompressed_latin1_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text_chunk.text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    for text_chunk in &info.utf8_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let text = text_chunk
                .get_text()
                .map_err(|e| format!("Failed to decode iTXt metadata text: {}", e))?;
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    for text_chunk in &info.compressed_latin1_text {
        if text_chunk.keyword == STORYBOARD_METADATA_PNG_TEXT_KEY {
            let text = text_chunk
                .get_text()
                .map_err(|e| format!("Failed to decode zTXt metadata text: {}", e))?;
            let parsed = serde_json::from_str::<StoryboardImageMetadata>(&text)
                .map_err(|e| format!("Invalid storyboard metadata JSON: {}", e))?;
            return Ok(Some(parsed));
        }
    }

    Ok(None)
}

fn encode_png_with_storyboard_metadata(
    image: &DynamicImage,
    metadata: &StoryboardImageMetadata,
) -> Result<Vec<u8>, String> {
    let metadata_json = serde_json::to_string(metadata)
        .map_err(|e| format!("Failed to serialize storyboard metadata: {}", e))?;
    let rgba = image.to_rgba8();
    let width = rgba.width().max(1);
    let height = rgba.height().max(1);
    let mut output = Vec::new();

    {
        let mut encoder = Encoder::new(&mut output, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        encoder
            .add_itxt_chunk(
                STORYBOARD_METADATA_PNG_TEXT_KEY.to_string(),
                metadata_json,
            )
            .map_err(|e| format!("Failed to attach storyboard metadata into PNG: {}", e))?;
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("Failed to write PNG header: {}", e))?;
        writer
            .write_image_data(rgba.as_raw())
            .map_err(|e| format!("Failed to encode PNG pixels: {}", e))?;
    }

    Ok(output)
}

async fn resolve_source_bytes(source: &str) -> Result<(Vec<u8>, String), String> {
    if source.starts_with("data:") {
        return parse_data_url(source);
    }

    if source.starts_with("http://") || source.starts_with("https://") {
        let response = reqwest::get(source)
            .await
            .map_err(|e| format!("Failed to download remote image: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Remote image request failed with status {}",
                response.status()
            ));
        }

        let mime_ext = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(extension_from_mime);

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read remote image body: {}", e))?
            .to_vec();

        let ext = mime_ext
            .or_else(|| extension_from_path_like(source))
            .unwrap_or_else(|| "png".to_string());

        return Ok((bytes, ext));
    }

    if source.starts_with("file://") {
        let file_path = decode_file_url_path(source);
        let local_path = PathBuf::from(file_path);
        let bytes = std::fs::read(&local_path)
            .map_err(|e| format!("Failed to read file:// image source: {}", e))?;
        let ext = local_path
            .extension()
            .and_then(|item| item.to_str())
            .map(normalize_extension)
            .unwrap_or_else(|| "png".to_string());
        return Ok((bytes, ext));
    }

    // Handle asset:// protocol (used by Tauri for app resources)
    if source.starts_with("asset://") {
        let path_part = source
            .strip_prefix("asset://localhost/")
            .or_else(|| source.strip_prefix("asset:///"))
            .ok_or_else(|| format!("Invalid asset URL format: {}", source))?;
        let decoded = urlencoding::decode(path_part)
            .map_err(|e| format!("URL decode failed: {}", e))?;
        let file_path = decoded.trim_start_matches('/');
        let local_path = PathBuf::from(&file_path);
        let bytes = std::fs::read(&local_path)
            .or_else(|_| {
                std::fs::canonicalize(&file_path).and_then(|c| {
                    let canonical_str = c.to_string_lossy();
                    let clean = canonical_str.strip_prefix("\\\\?\\").unwrap_or(&canonical_str);
                    std::fs::read(clean)
                })
            })
            .map_err(|e| format!("Failed to read asset source {}: {}", file_path, e))?;
        let ext = local_path
            .extension()
            .and_then(|item| item.to_str())
            .map(normalize_extension)
            .unwrap_or_else(|| "png".to_string());
        return Ok((bytes, ext));
    }

    let local_path = PathBuf::from(source);
    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local image source: {}", e))?;
    let ext = local_path
        .extension()
        .and_then(|item| item.to_str())
        .map(normalize_extension)
        .unwrap_or_else(|| "png".to_string());

    Ok((bytes, ext))
}

#[tauri::command]
pub async fn read_storyboard_image_metadata(
    source: String,
) -> Result<Option<StoryboardImageMetadata>, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    if extension != "png" {
        return Ok(None);
    }

    read_storyboard_metadata_from_png_bytes(&bytes)
}

#[tauri::command]
pub async fn embed_storyboard_image_metadata(
    app: AppHandle,
    source: String,
    metadata: StoryboardImageMetadata,
    project_id: Option<String>,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image for metadata embedding: {}", e))?;
    let encoded = encode_png_with_storyboard_metadata(&image, &metadata)?;

    persist_image_bytes(&app, &encoded, "png", project_id.as_deref())
}

#[tauri::command]
pub async fn persist_image_source(
    app: AppHandle,
    source: String,
    project_id: Option<String>,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;

    // Decode and re-encode as JPEG for uniform format
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image for JPEG conversion: {}", e))?;
    let mut jpeg_buffer = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buffer, 90);
    image
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;

    persist_image_bytes(&app, jpeg_buffer.get_ref(), "jpg", project_id.as_deref())
}

#[tauri::command]
pub async fn persist_image_binary(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: Option<String>,
    project_id: Option<String>,
) -> Result<String, String> {
    let started = Instant::now();
    if bytes.is_empty() {
        return Err("Image bytes are empty".to_string());
    }

    let resolved_extension = extension
        .as_deref()
        .map(normalize_extension)
        .unwrap_or_else(|| "jpg".to_string());

    let output = persist_image_bytes(&app, &bytes, &resolved_extension, project_id.as_deref())?;
    info!(
        "persist_image_binary done: bytes={}, ext={}, elapsed={}ms",
        bytes.len(),
        resolved_extension,
        started.elapsed().as_millis()
    );
    Ok(output)
}

fn sanitize_file_stem(raw: &str) -> String {
    let trimmed = raw.trim();
    let fallback = "storyboard-image";
    if trimmed.is_empty() {
        return fallback.to_string();
    }

    let mut sanitized = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let blocked = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*');
        if blocked || ch.is_control() {
            continue;
        }
        sanitized.push(ch);
    }

    let compact = sanitized.trim().trim_matches('.').to_string();
    if compact.is_empty() {
        fallback.to_string()
    } else {
        compact
    }
}

fn ensure_unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("storyboard-image");
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("png");

    for index in 1..10_000_u32 {
        let candidate = parent.join(format!("{}-{}.{}", stem, index, ext));
        if !candidate.exists() {
            return candidate;
        }
    }

    path
}

fn ensure_output_path_with_extension(path: &Path, extension: &str) -> PathBuf {
    if path.extension().is_some() {
        return path.to_path_buf();
    }

    let mut with_extension = path.to_path_buf();
    with_extension.set_extension(normalize_extension(extension));
    with_extension
}

#[tauri::command]
pub async fn save_image_source_to_downloads(
    source: String,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed).await?;
    let user_dirs = UserDirs::new().ok_or_else(|| "Failed to resolve user dirs".to_string())?;
    let downloads_dir = user_dirs
        .download_dir()
        .or_else(|| user_dirs.desktop_dir())
        .or_else(|| Some(user_dirs.home_dir()))
        .ok_or_else(|| "Failed to resolve downloads dir".to_string())?;
    std::fs::create_dir_all(downloads_dir)
        .map_err(|e| format!("Failed to create downloads dir: {}", e))?;

    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("storyboard-{}", now_millis)
    } else {
        stem
    };

    let output_path = ensure_unique_path(downloads_dir.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));
    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image into downloads: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_path(source: String, target_path: String) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let trimmed_target = target_path.trim();
    if trimmed_target.is_empty() {
        return Err("Target path is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let raw_path = PathBuf::from(trimmed_target);
    let output_path = ensure_output_path_with_extension(&raw_path, &extension);

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output dir: {}", e))?;
    }

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to target path: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_directory(
    source: String,
    target_dir: String,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let trimmed_dir = target_dir.trim();
    if trimmed_dir.is_empty() {
        return Err("Target directory is empty".to_string());
    }

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let dir_path = PathBuf::from(trimmed_dir);
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("storyboard-{}", now_millis)
    } else {
        stem
    };

    let output_path = ensure_unique_path(dir_path.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));
    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to target directory: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_image_source_to_app_debug_dir(
    app: AppHandle,
    source: String,
    category: Option<String>,
    suggested_file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_source = source.trim();
    if trimmed_source.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let normalized_category = sanitize_file_stem(category.as_deref().unwrap_or("grid"));
    let target_dir = app_data_dir.join("debug").join(normalized_category);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create app debug dir: {}", e))?;

    let (bytes, extension) = resolve_source_bytes(trimmed_source).await?;
    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to resolve current time: {}", e))?
        .as_millis();
    let stem = sanitize_file_stem(suggested_file_name.as_deref().unwrap_or(""));
    let default_stem = if stem == "storyboard-image" {
        format!("debug-{}", now_millis)
    } else {
        stem
    };
    let output_path = ensure_unique_path(target_dir.join(format!(
        "{}.{}",
        default_stem,
        normalize_extension(&extension)
    )));

    std::fs::write(&output_path, bytes)
        .map_err(|e| format!("Failed to save image to app debug dir: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_image_source_to_clipboard(source: String) -> Result<(), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("Image source is empty".to_string());
    }

    let (bytes, _extension) = resolve_source_bytes(trimmed).await?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image source: {}", e))?
        .to_rgba8();
    let width = image.width() as usize;
    let height = image.height() as usize;
    let pixels = image.into_raw();

    let mut clipboard = Clipboard::new()
        .map_err(|e| format!("Failed to access clipboard: {}", e))?;
    clipboard
        .set_image(ImageData {
            width,
            height,
            bytes: Cow::Owned(pixels),
        })
        .map_err(|e| format!("Failed to write image into clipboard: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn load_image(file_path: String) -> Result<String, String> {
    info!("Loading image from: {}", file_path);

    let image_data =
        std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let base64_data = STANDARD.encode(&image_data);

    let mime = if file_path.ends_with(".png") {
        "image/png"
    } else if file_path.ends_with(".jpg") || file_path.ends_with(".jpeg") {
        "image/jpeg"
    } else if file_path.ends_with(".gif") {
        "image/gif"
    } else if file_path.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };

    Ok(format!("data:{};base64,{}", mime, base64_data))
}

#[tauri::command]
pub async fn save_video_source_to_path(
    video_url: String,
    target_path: String,
) -> Result<String, String> {
    info!(
        "Downloading video from {} to {}",
        video_url, target_path
    );

    let bytes = if video_url.starts_with("data:") {
        let parts: Vec<&str> = video_url.splitn(2, ',').collect();
        if parts.len() != 2 {
            return Err("Invalid data URL".to_string());
        }
        STANDARD
            .decode(parts[1])
            .map_err(|e| format!("Base64 decode: {}", e))?
    } else if video_url.starts_with("asset://") {
        // Handle asset:// protocol - read local file directly
        let path_part = video_url
            .strip_prefix("asset://localhost/")
            .or_else(|| video_url.strip_prefix("asset:///"))
            .ok_or_else(|| format!("Invalid asset URL format: {}", video_url))?;
        let decoded = urlencoding::decode(path_part)
            .map_err(|e| format!("URL decode failed: {}", e))?;
        let file_path = decoded.trim_start_matches('/');
        // Try reading directly first, then canonicalize
        std::fs::read(&file_path)
            .or_else(|_| {
                std::fs::canonicalize(&file_path).and_then(|c| {
                    let canonical_str = c.to_string_lossy();
                    let clean = canonical_str.strip_prefix("\\\\?\\").unwrap_or(&canonical_str);
                    std::fs::read(clean)
                })
            })
            .map_err(|e| format!("Failed to read asset file {}: {}", file_path, e))?
    } else if video_url.starts_with("file://") {
        // Handle file:// protocol
        let path_part = video_url.strip_prefix("file://").unwrap_or(&video_url);
        let decoded = urlencoding::decode(path_part)
            .map_err(|e| format!("file URL decode failed: {}", e))?;
        let file_path = decoded.trim_start_matches('/');
        std::fs::read(&file_path)
            .map_err(|e| format!("Failed to read file:// {}: {}", file_path, e))?
    } else {
        // Check if it's a local file path (not HTTP/HTTPS URL)
        let trimmed = video_url.trim();
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            // Local file path - read directly
            let local_path = PathBuf::from(trimmed);
            if local_path.exists() {
                std::fs::read(&local_path)
                    .map_err(|e| format!("Failed to read local file {}: {}", trimmed, e))?
            } else {
                // Try as relative path from project data dir
                let app_data_dir = std::env::current_dir()
                    .map_err(|e| format!("Failed to get current dir: {}", e))?;
                let full_path = app_data_dir.join(&local_path);
                std::fs::read(&full_path)
                    .map_err(|e| format!("Failed to read local file {} (tried {}): {}", trimmed, full_path.display(), e))?
            }
        } else {
            // HTTP/HTTPS URL - fetch via network
            let response = reqwest::get(&video_url)
                .await
                .map_err(|e| format!("HTTP GET {}: {}", video_url, e))?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}: {}", response.status(), video_url));
            }
            response
                .bytes()
                .await
                .map_err(|e| format!("Read response body: {}", e))?
                .to_vec()
        }
    };

    let target = PathBuf::from(&target_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Create directory {}: {}", parent.display(), e))?;
    }
    std::fs::write(&target, &bytes)
        .map_err(|e| format!("Write file {}: {}", target_path, e))?;

    info!("Video saved to: {}", target_path);
    Ok(target_path)
}

#[tauri::command]
pub async fn auto_save_video_to_project(
    app: AppHandle,
    video_url: String,
    project_id: String,
) -> Result<String, String> {
    let bytes = if video_url.starts_with("data:") {
        let parts: Vec<&str> = video_url.splitn(2, ',').collect();
        if parts.len() != 2 {
            return Err("Invalid data URL".to_string());
        }
        STANDARD
            .decode(parts[1])
            .map_err(|e| format!("Base64 decode: {}", e))?
    } else {
        let response = reqwest::get(&video_url)
            .await
            .map_err(|e| format!("HTTP GET {}: {}", video_url, e))?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}: {}", response.status(), video_url));
        }
        response
            .bytes()
            .await
            .map_err(|e| format!("Read response body: {}", e))?
            .to_vec()
    };

    let outputs_dir = resolve_project_dir(&app, &project_id, "outputs/videos")?;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let process_id = std::process::id() as u64;
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let filename = format!("video_{}_{}_{}.mp4", timestamp, process_id, counter);
    let output_path = outputs_dir.join(&filename);

    std::fs::write(&output_path, &bytes)
        .map_err(|e| format!("Failed to save video: {}", e))?;

    info!("Video auto-saved to project {}: {}", project_id, output_path.display());
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn auto_save_image_to_project(
    app: AppHandle,
    image_url: String,
    project_id: String,
    provider_name: Option<String>,
    model_name: Option<String>,
) -> Result<String, String> {
    info!("[auto_save_image_to_project] START project_id={}, url={}", project_id, &image_url[..image_url.len().min(100)]);
    let bytes = if image_url.starts_with("data:") {
        let parts: Vec<&str> = image_url.splitn(2, ',').collect();
        if parts.len() != 2 {
            return Err("Invalid data URL".to_string());
        }
        STANDARD
            .decode(parts[1])
            .map_err(|e| format!("Base64 decode: {}", e))?
    } else if image_url.starts_with("http://") || image_url.starts_with("https://") {
        let response = reqwest::get(&image_url)
            .await
            .map_err(|e| format!("HTTP GET {}: {}", image_url, e))?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}: {}", response.status(), image_url));
        }
        response
            .bytes()
            .await
            .map_err(|e| format!("Read response body: {}", e))?
            .to_vec()
    } else {
        // Local file path - read directly
        let local_path = if image_url.starts_with("file://") {
            PathBuf::from(decode_file_url_path(&image_url))
        } else {
            PathBuf::from(&image_url)
        };
        std::fs::read(&local_path)
            .map_err(|e| format!("Read local file {}: {}", image_url, e))?
    };

    let outputs_dir = resolve_project_dir(&app, &project_id, "outputs/images")?;
    let output_path = save_generated_image_bytes(
        &outputs_dir,
        &bytes,
        provider_name.as_deref(),
        model_name.as_deref(),
    )?;

    info!("Generated image auto-saved to project {}: {}", project_id, output_path.display());
    Ok(output_path.to_string_lossy().to_string())
}

/// Convert local image to data URL for text polishing APIs
/// Text APIs accept inline base64 images, so we don't need external hosting
#[tauri::command]
pub async fn convert_image_to_data_url(source: String) -> Result<String, String> {
    info!("[convert_data_url] starting, source length: {}", source.len());

    // Use resolve_source_bytes to get image bytes from any source type
    let (image_bytes, extension) = resolve_source_bytes(&source).await
        .map_err(|e| format!("[convert_data_url] Failed to read image: {}", e))?;

    if image_bytes.is_empty() {
        return Err("[convert_data_url] Image data is empty".to_string());
    }

    info!("[convert_data_url] image bytes: {} KB", image_bytes.len() / 1024);

    // Encode to base64
    let base64_data = STANDARD.encode(&image_bytes);

    // Determine MIME type from extension
    let mime_type = match extension.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };

    let data_url = format!("data:{};base64,{}", mime_type, base64_data);
    info!("[convert_data_url] converted to data URL, length: {}", data_url.len());

    Ok(data_url)
}

#[tauri::command]
pub async fn upload_image_to_volc_vod(source: String) -> Result<String, String> {
    let media = resolve_media_source(&source).await?;
    Ok(tos::upload_media(media, None).await?.url)
}

#[tauri::command]
pub async fn upload_media_to_public_url(source: String) -> Result<String, String> {
    let media = resolve_media_source(&source).await?;
    Ok(tos::upload_media(media, None).await?.url)
}

/// Open a URL in Microsoft Edge browser on Windows
#[tauri::command]
pub async fn open_in_edge(url: String) -> Result<(), String> {
    info!("[open_in_edge] Opening URL: {}", url);

    // Validate URL
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Invalid URL: must start with http:// or https://".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // Try Edge installation paths
        let edge_paths = [
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ];

        for edge_path in &edge_paths {
            let result = Command::new(edge_path)
                .arg(&url)
                .spawn();

            match result {
                Ok(_) => {
                    info!("[open_in_edge] Successfully opened URL in Edge: {}", edge_path);
                    return Ok(());
                }
                Err(_) => continue,
            }
        }

        // Fallback: try using cmd /c start with msedge protocol
        let result = Command::new("cmd")
            .args(["/c", "start", "msedge:", &url])
            .output();

        match result {
            Ok(output) => {
                if output.status.success() {
                    info!("[open_in_edge] Successfully opened URL via msedge protocol");
                    Ok(())
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    Err(format!("Failed to open URL: {}", stderr))
                }
            }
            Err(e) => Err(format!("Failed to execute command: {}", e)),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows, use default browser via open command
        use std::process::Command;
        let result = Command::new("open")
            .arg(&url)
            .output();

        match result {
            Ok(output) => {
                if output.status.success() {
                    Ok(())
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    Err(format!("Failed to open URL: {}", stderr))
                }
            }
            Err(e) => Err(format!("Failed to execute command: {}", e)),
        }
    }
}

/// Delete an image file from the project's uploads directory.
/// This is called when an upload node is deleted to clean up orphaned files.
/// Only deletes files within the project's uploads directory for safety.
#[tauri::command]
pub async fn delete_project_upload_file(
    app: AppHandle,
    project_id: String,
    filename: String,
) -> Result<(), String> {
    // Security check: filename should not contain path separators or special characters
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename: path separators and '..' are not allowed".to_string());
    }

    let uploads_dir = resolve_project_dir(&app, &project_id, "uploads")?;
    let file_path = uploads_dir.join(&filename);

    // Verify the file exists and is within the uploads directory
    // This prevents accidental deletion of system files
    let canonical_uploads = uploads_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve uploads dir: {}", e))?;
    let canonical_file = file_path.canonicalize()
        .map_err(|e| format!("File does not exist or cannot be accessed: {}", e))?;

    // Ensure the file is within the uploads directory
    if !canonical_file.starts_with(&canonical_uploads) {
        return Err("Security violation: file is not within project uploads directory".to_string());
    }

    std::fs::remove_file(&canonical_file)
        .map_err(|e| format!("Failed to delete file {}: {}", filename, e))?;

    info!("Deleted project upload file: {}/{}", project_id, filename);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_generated_image_filename, decode_asset_url_path, decode_file_url_path,
        save_generated_image_bytes,
    };
    use image::{DynamicImage, Rgba, RgbaImage};
    use std::fs;
    use std::io::Cursor;
    use uuid::Uuid;

    #[test]
    fn generated_image_filename_uses_provider_model_seconds_and_random_suffix() {
        assert_eq!(
            build_generated_image_filename(
                "OpenAI",
                "GPT Image 1",
                "20260812_143015",
                "a1b2c3d4",
                "png",
            ),
            "OpenAI_GPT_Image_1_20260812_143015_a1b2c3d4.png"
        );
    }

    #[test]
    fn generated_image_filename_normalizes_provider_name() {
        assert_eq!(
            build_generated_image_filename(
                "My / Provider",
                "Model / Preview",
                "20260812_143015",
                "a1b2c3d4",
                "webp",
            ),
            "My_Provider_Model_Preview_20260812_143015_a1b2c3d4.webp"
        );
    }

    #[test]
    fn decodes_local_media_urls_without_losing_the_root_path() {
        if cfg!(target_os = "windows") {
            assert_eq!(decode_file_url_path("file:///C:/Users/mir/media.mp4"), "C:/Users/mir/media.mp4");
            assert_eq!(
                decode_asset_url_path("asset://localhost/C:/Users/mir/media.mp4").unwrap(),
                std::path::PathBuf::from("C:/Users/mir/media.mp4")
            );
        } else {
            assert_eq!(decode_file_url_path("file:///Users/mir/media.mp4"), "/Users/mir/media.mp4");
            assert_eq!(
                decode_asset_url_path("asset://localhost/Users/mir/media.mp4").unwrap(),
                std::path::PathBuf::from("/Users/mir/media.mp4")
            );
        }
    }

    #[test]
    fn generated_image_save_preserves_png_bytes_and_extension() {
        let temp_dir = std::env::temp_dir().join(format!(
            "lumina-generated-image-save-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let source_image =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, Rgba([23, 57, 91, 255])));
        let mut source = Cursor::new(Vec::new());
        source_image
            .write_to(&mut source, image::ImageFormat::Png)
            .unwrap();
        let source_bytes = source.into_inner();

        let output_path = save_generated_image_bytes(
            &temp_dir,
            &source_bytes,
            Some("AI Media"),
            Some("Image Model"),
        )
        .unwrap();
        let saved_bytes = fs::read(&output_path).unwrap();
        let extension = output_path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_owned);
        fs::remove_dir_all(&temp_dir).unwrap();

        assert_eq!(extension.as_deref(), Some("png"));
        assert!(output_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("AI_Media_Image_Model_")));
        assert_eq!(saved_bytes, source_bytes);
    }
}
