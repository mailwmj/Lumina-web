use fast_image_resize as fir;
use fast_image_resize::images::Image as FirImage;
use image::metadata::Orientation;
use image::{DynamicImage, GrayImage, ImageDecoder, ImageReader, Luma, Rgb, RgbImage};
use imageproc::filter::gaussian_blur_f32;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 60 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 120_000_000;
const PREVIEW_LONGEST_EDGE: u32 = 2560;
const THUMBNAIL_LONGEST_EDGE: u32 = 160;
const PREVIEW_JPEG_QUALITY: u8 = 90;
const THUMBNAIL_JPEG_QUALITY: u8 = 82;
const OUTPUT_SHARPEN_SIGMA: f32 = 0.65;
const OUTPUT_SHARPEN_AMOUNT: f32 = 0.35;
const OUTPUT_SHARPEN_THRESHOLD: f32 = 3.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedBatchCropImage {
    source_path: String,
    file_name: String,
    file_size: u64,
    preview_path: String,
    thumbnail_path: String,
    width: u32,
    height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggestion: Option<BatchCropSuggestion>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedCropRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCropSuggestion {
    crop: NormalizedCropRect,
    requires_review: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBatchCropImagePayload {
    source_path: String,
    file_name: String,
    output_directory: String,
    target_width: u32,
    target_height: u32,
    rotation_degrees: i32,
    crop: NormalizedCropRect,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedBatchCropImage {
    output_path: String,
}

fn sanitize_batch_id(value: &str) -> Result<String, String> {
    let sanitized: String = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .take(80)
        .collect();
    if sanitized.is_empty() {
        Err("Invalid batch id".to_string())
    } else {
        Ok(sanitized)
    }
}

pub(crate) fn batch_cache_dir(app: &AppHandle, batch_id: &str) -> Result<PathBuf, String> {
    let safe_batch_id = sanitize_batch_id(batch_id)?;
    let directory = app
        .path()
        .temp_dir()
        .map_err(|error| format!("Failed to resolve temp directory: {error}"))?
        .join("lumina-batch-image-crop")
        .join(safe_batch_id);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create preview directory: {error}"))?;
    Ok(directory)
}

pub(crate) fn validate_source_path(source_path: &str) -> Result<(PathBuf, u64, String), String> {
    let source = PathBuf::from(source_path);
    let metadata = std::fs::metadata(&source).map_err(|_| "SOURCE_NOT_FOUND".to_string())?;
    if !metadata.is_file() {
        return Err("SOURCE_NOT_FILE".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("FILE_TOO_LARGE".to_string());
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
        return Err("UNSUPPORTED_FORMAT".to_string());
    }

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "INVALID_FILE_NAME".to_string())?
        .to_string();
    Ok((source, metadata.len(), file_name))
}

pub(crate) fn load_oriented_image(path: &Path) -> Result<DynamicImage, String> {
    let file = File::open(path).map_err(|_| "SOURCE_NOT_FOUND".to_string())?;
    let reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| "INVALID_IMAGE".to_string())?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "INVALID_IMAGE".to_string())?;
    let (width, height) = decoder.dimensions();
    validate_image_dimensions(width, height)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| "INVALID_IMAGE".to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn validate_image_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("INVALID_IMAGE".to_string());
    }
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS {
        return Err("IMAGE_DIMENSIONS_TOO_LARGE".to_string());
    }
    Ok(())
}

pub(crate) fn apply_rotation(image: DynamicImage, rotation_degrees: i32) -> DynamicImage {
    match rotation_degrees.rem_euclid(360) {
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => image,
    }
}

fn resized_dimensions(width: u32, height: u32, longest_edge: u32) -> (u32, u32) {
    let safe_width = width.max(1);
    let safe_height = height.max(1);
    let longest = safe_width.max(safe_height);
    if longest <= longest_edge {
        return (safe_width, safe_height);
    }
    let scale = longest_edge as f64 / longest as f64;
    (
        (safe_width as f64 * scale).round().max(1.0) as u32,
        (safe_height as f64 * scale).round().max(1.0) as u32,
    )
}

fn resize_rgba_with_filter(
    source: &DynamicImage,
    target_width: u32,
    target_height: u32,
    filter_type: fir::FilterType,
) -> Result<image::RgbaImage, String> {
    let source_rgba = source.to_rgba8();
    let source_image = FirImage::from_vec_u8(
        source_rgba.width().max(1),
        source_rgba.height().max(1),
        source_rgba.into_raw(),
        fir::PixelType::U8x4,
    )
    .map_err(|error| format!("Failed to prepare image resize: {error}"))?;
    let mut target = FirImage::new(
        target_width.max(1),
        target_height.max(1),
        fir::PixelType::U8x4,
    );
    let options = fir::ResizeOptions::new().resize_alg(fir::ResizeAlg::Convolution(filter_type));
    fir::Resizer::new()
        .resize(&source_image, &mut target, Some(&options))
        .map_err(|error| format!("Failed to resize image: {error}"))?;
    image::RgbaImage::from_raw(target_width.max(1), target_height.max(1), target.into_vec())
        .ok_or_else(|| "Failed to build resized image".to_string())
}

pub(crate) fn resize_rgba_lanczos3(
    source: &DynamicImage,
    target_width: u32,
    target_height: u32,
) -> Result<image::RgbaImage, String> {
    resize_rgba_with_filter(
        source,
        target_width,
        target_height,
        fir::FilterType::Lanczos3,
    )
}

fn resize_rgba_for_preview(
    source: &DynamicImage,
    target_width: u32,
    target_height: u32,
) -> Result<image::RgbaImage, String> {
    resize_rgba_with_filter(
        source,
        target_width,
        target_height,
        fir::FilterType::CatmullRom,
    )
}

fn write_preview_jpeg(image: &DynamicImage, output_path: &Path, quality: u8) -> Result<(), String> {
    let output =
        File::create(output_path).map_err(|error| format!("Failed to create preview: {error}"))?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(output, quality);
    DynamicImage::ImageRgb8(flatten_to_white(image))
        .write_with_encoder(encoder)
        .map_err(|error| format!("Failed to encode preview: {error}"))
}

fn write_resized_preview_jpeg(
    image: &DynamicImage,
    output_path: &Path,
    longest_edge: u32,
    quality: u8,
) -> Result<(), String> {
    let (target_width, target_height) =
        resized_dimensions(image.width(), image.height(), longest_edge);
    if target_width == image.width() && target_height == image.height() {
        return write_preview_jpeg(image, output_path, quality);
    }

    let resized =
        DynamicImage::ImageRgba8(resize_rgba_for_preview(image, target_width, target_height)?);
    write_preview_jpeg(&resized, output_path, quality)
}

fn write_preview_assets(
    image: &DynamicImage,
    preview_path: &Path,
    thumbnail_path: &Path,
) -> Result<(), String> {
    let (preview_width, preview_height) =
        resized_dimensions(image.width(), image.height(), PREVIEW_LONGEST_EDGE);

    if preview_width == image.width() && preview_height == image.height() {
        write_preview_jpeg(image, preview_path, PREVIEW_JPEG_QUALITY)?;
        return write_resized_preview_jpeg(
            image,
            thumbnail_path,
            THUMBNAIL_LONGEST_EDGE,
            THUMBNAIL_JPEG_QUALITY,
        );
    }

    // Thumbnails are derived from the display preview, so the full source is resized only once.
    let preview = DynamicImage::ImageRgba8(resize_rgba_for_preview(
        image,
        preview_width,
        preview_height,
    )?);
    write_preview_jpeg(&preview, preview_path, PREVIEW_JPEG_QUALITY)?;
    write_resized_preview_jpeg(
        &preview,
        thumbnail_path,
        THUMBNAIL_LONGEST_EDGE,
        THUMBNAIL_JPEG_QUALITY,
    )
}

fn prepare_batch_crop_image_sync(
    app: AppHandle,
    batch_id: String,
    source_path: String,
    rotation_degrees: i32,
    target_width: Option<u32>,
    target_height: Option<u32>,
) -> Result<PreparedBatchCropImage, String> {
    let (source, file_size, file_name) = validate_source_path(&source_path)?;
    let image = apply_rotation(load_oriented_image(&source)?, rotation_degrees);
    let cache = batch_cache_dir(&app, &batch_id)?;
    let asset_id = Uuid::new_v4().simple().to_string();
    let preview_path = cache.join(format!("{asset_id}-preview.jpg"));
    let thumbnail_path = cache.join(format!("{asset_id}-thumbnail.jpg"));

    write_preview_assets(&image, &preview_path, &thumbnail_path)?;
    let suggestion = match (target_width, target_height) {
        (None, None) => None,
        (Some(target_width), Some(target_height)) if target_width > 0 && target_height > 0 => Some(
            default_crop_suggestion(image.width(), image.height(), target_width, target_height),
        ),
        _ => return Err("INVALID_TARGET_SIZE".to_string()),
    };

    Ok(PreparedBatchCropImage {
        source_path: source.to_string_lossy().to_string(),
        file_name,
        file_size,
        preview_path: preview_path.to_string_lossy().to_string(),
        thumbnail_path: thumbnail_path.to_string_lossy().to_string(),
        width: image.width(),
        height: image.height(),
        suggestion,
    })
}

#[tauri::command]
pub async fn prepare_batch_crop_image(
    app: AppHandle,
    batch_id: String,
    source_path: String,
    rotation_degrees: i32,
    target_width: Option<u32>,
    target_height: Option<u32>,
) -> Result<PreparedBatchCropImage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_batch_crop_image_sync(
            app,
            batch_id,
            source_path,
            rotation_degrees,
            target_width,
            target_height,
        )
    })
    .await
    .map_err(|error| format!("Image preview task failed: {error}"))?
}

fn centered_crop(
    width: u32,
    height: u32,
    target_width: u32,
    target_height: u32,
) -> NormalizedCropRect {
    let source_ratio = width.max(1) as f64 / height.max(1) as f64;
    let target_ratio = target_width.max(1) as f64 / target_height.max(1) as f64;
    if source_ratio > target_ratio {
        let crop_width = target_ratio / source_ratio;
        NormalizedCropRect {
            x: (1.0 - crop_width) / 2.0,
            y: 0.0,
            width: crop_width,
            height: 1.0,
        }
    } else {
        let crop_height = source_ratio / target_ratio;
        NormalizedCropRect {
            x: 0.0,
            y: (1.0 - crop_height) / 2.0,
            width: 1.0,
            height: crop_height,
        }
    }
}

fn default_crop_suggestion(
    image_width: u32,
    image_height: u32,
    target_width: u32,
    target_height: u32,
) -> BatchCropSuggestion {
    let crop = centered_crop(image_width, image_height, target_width, target_height);
    let retained_area = crop.width * crop.height;
    BatchCropSuggestion {
        crop,
        requires_review: retained_area < 0.8,
    }
}

fn suggest_batch_crop_sync(
    preview_path: String,
    target_width: u32,
    target_height: u32,
) -> Result<BatchCropSuggestion, String> {
    let (image_width, image_height) =
        image::image_dimensions(&preview_path).map_err(|_| "PREVIEW_NOT_FOUND".to_string())?;
    Ok(default_crop_suggestion(
        image_width,
        image_height,
        target_width,
        target_height,
    ))
}

#[tauri::command]
pub async fn suggest_batch_crop(
    preview_path: String,
    target_width: u32,
    target_height: u32,
) -> Result<BatchCropSuggestion, String> {
    tauri::async_runtime::spawn_blocking(move || {
        suggest_batch_crop_sync(preview_path, target_width, target_height)
    })
    .await
    .map_err(|error| format!("Crop suggestion task failed: {error}"))?
}

fn sanitize_stem(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let normalized: String = stem
        .chars()
        .map(|character| {
            if !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = normalized.trim_matches(['_', ' ', '.']);
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn available_output_path(
    directory: &Path,
    file_name: &str,
    target_width: u32,
    target_height: u32,
) -> PathBuf {
    let stem = sanitize_stem(file_name);
    let base = format!("{stem}_{target_width}x{target_height}");
    let initial = directory.join(format!("{base}.jpg"));
    if !initial.exists() {
        return initial;
    }
    for suffix in 2_u32.. {
        let candidate = directory.join(format!("{base}_{suffix}.jpg"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

pub(crate) fn flatten_to_white(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut output = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = pixel[3] as u16;
        let inverse = 255_u16 - alpha;
        output.put_pixel(
            x,
            y,
            Rgb([
                ((pixel[0] as u16 * alpha + 255 * inverse) / 255) as u8,
                ((pixel[1] as u16 * alpha + 255 * inverse) / 255) as u8,
                ((pixel[2] as u16 * alpha + 255 * inverse) / 255) as u8,
            ]),
        );
    }
    output
}

fn rgb_luminance(pixel: &Rgb<u8>) -> u8 {
    (0.2126 * pixel[0] as f32 + 0.7152 * pixel[1] as f32 + 0.0722 * pixel[2] as f32)
        .round()
        .clamp(0.0, 255.0) as u8
}

fn sharpen_luminance_usm(image: &RgbImage) -> RgbImage {
    let luminance = GrayImage::from_fn(image.width(), image.height(), |x, y| {
        Luma([rgb_luminance(image.get_pixel(x, y))])
    });
    let blurred = gaussian_blur_f32(&luminance, OUTPUT_SHARPEN_SIGMA);
    let mut output = image.clone();

    for (x, y, pixel) in output.enumerate_pixels_mut() {
        let detail = luminance.get_pixel(x, y)[0] as f32 - blurred.get_pixel(x, y)[0] as f32;
        if detail.abs() < OUTPUT_SHARPEN_THRESHOLD {
            continue;
        }

        let adjustment = (OUTPUT_SHARPEN_AMOUNT * detail).round() as i16;
        for channel in &mut pixel.0 {
            *channel = (i16::from(*channel) + adjustment).clamp(0, 255) as u8;
        }
    }

    output
}

fn should_sharpen_after_resize(
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> bool {
    source_width > target_width || source_height > target_height
}

fn resolve_pixel_crop(
    image_width: u32,
    image_height: u32,
    crop: &NormalizedCropRect,
    target_width: u32,
    target_height: u32,
) -> (u32, u32, u32, u32) {
    let image_width = image_width.max(1);
    let image_height = image_height.max(1);
    let requested_width = (crop.width.clamp(0.000_001, 1.0) * image_width as f64)
        .round()
        .max(1.0) as u32;
    let requested_height = (crop.height.clamp(0.000_001, 1.0) * image_height as f64)
        .round()
        .max(1.0) as u32;
    let divisor = gcd(target_width.max(1), target_height.max(1));
    let ratio_width = target_width.max(1) / divisor;
    let ratio_height = target_height.max(1) / divisor;
    let scale = (requested_width / ratio_width)
        .min(requested_height / ratio_height)
        .max(1);
    let width = (ratio_width * scale).min(image_width);
    let height = (ratio_height * scale).min(image_height);
    let center_x =
        ((crop.x + crop.width / 2.0).clamp(0.0, 1.0) * image_width as f64).round() as i64;
    let center_y =
        ((crop.y + crop.height / 2.0).clamp(0.0, 1.0) * image_height as f64).round() as i64;
    let x = (center_x - width as i64 / 2).clamp(0, (image_width - width) as i64) as u32;
    let y = (center_y - height as i64 / 2).clamp(0, (image_height - height) as i64) as u32;
    (x, y, width, height)
}

fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left.max(1)
}

fn export_batch_crop_image_sync(
    payload: ExportBatchCropImagePayload,
) -> Result<ExportedBatchCropImage, String> {
    if payload.target_width == 0 || payload.target_height == 0 {
        return Err("INVALID_TARGET_SIZE".to_string());
    }
    let (source, _, _) = validate_source_path(&payload.source_path)?;
    let output_directory = PathBuf::from(&payload.output_directory);
    let output_metadata = std::fs::metadata(&output_directory)
        .map_err(|_| "OUTPUT_DIRECTORY_NOT_FOUND".to_string())?;
    if !output_metadata.is_dir() {
        return Err("OUTPUT_DIRECTORY_NOT_FOUND".to_string());
    }

    let image = apply_rotation(load_oriented_image(&source)?, payload.rotation_degrees);
    let (crop_x, crop_y, crop_width, crop_height) = resolve_pixel_crop(
        image.width(),
        image.height(),
        &payload.crop,
        payload.target_width,
        payload.target_height,
    );
    let cropped = image.crop_imm(crop_x, crop_y, crop_width, crop_height);
    let resized = DynamicImage::ImageRgba8(resize_rgba_lanczos3(
        &cropped,
        payload.target_width,
        payload.target_height,
    )?);
    let flattened = flatten_to_white(&resized);
    let output_image = if should_sharpen_after_resize(
        crop_width,
        crop_height,
        payload.target_width,
        payload.target_height,
    ) {
        sharpen_luminance_usm(&flattened)
    } else {
        flattened
    };
    let output_path = available_output_path(
        &output_directory,
        &payload.file_name,
        payload.target_width,
        payload.target_height,
    );
    let output = File::create(&output_path).map_err(|_| "OUTPUT_WRITE_FAILED".to_string())?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(output, 100);
    DynamicImage::ImageRgb8(output_image)
        .write_with_encoder(encoder)
        .map_err(|_| "OUTPUT_WRITE_FAILED".to_string())?;

    Ok(ExportedBatchCropImage {
        output_path: output_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn export_batch_crop_image(
    payload: ExportBatchCropImagePayload,
) -> Result<ExportedBatchCropImage, String> {
    tauri::async_runtime::spawn_blocking(move || export_batch_crop_image_sync(payload))
        .await
        .map_err(|error| format!("Image export task failed: {error}"))?
}

#[tauri::command]
pub fn cleanup_batch_crop_cache(app: AppHandle, batch_id: String) -> Result<(), String> {
    let directory = batch_cache_dir(&app, &batch_id)?;
    if directory.exists() {
        std::fs::remove_dir_all(directory)
            .map_err(|error| format!("Failed to clear preview directory: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centered_crop_keeps_target_ratio() {
        let crop = centered_crop(4000, 6000, 1440, 1920);
        let ratio = (4000.0 * crop.width) / (6000.0 * crop.height);
        assert!((ratio - 0.75).abs() < 0.000_001);
    }

    #[test]
    fn default_suggestion_preserves_the_original_composition_when_crop_is_small() {
        let suggestion = default_crop_suggestion(3574, 5361, 1440, 1920);

        assert!((suggestion.crop.x - 0.0).abs() < 0.000_001);
        assert!((suggestion.crop.y - (1.0 / 18.0)).abs() < 0.000_001);
        assert!((suggestion.crop.width - 1.0).abs() < 0.000_001);
        assert!((suggestion.crop.height - (8.0 / 9.0)).abs() < 0.000_001);
        assert!(!suggestion.requires_review);
    }

    #[test]
    fn default_suggestion_flags_only_substantial_ratio_crops_for_review() {
        let square = default_crop_suggestion(3574, 5361, 1440, 1440);
        let tall = default_crop_suggestion(3574, 5361, 1440, 2200);

        assert!(square.requires_review);
        assert!(!tall.requires_review);
    }

    #[test]
    fn default_suggestion_depends_on_dimensions_not_image_contents() {
        let root = std::env::temp_dir().join(format!("lumina-batch-crop-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let light = root.join("light.jpg");
        let patterned = root.join("patterned.jpg");
        DynamicImage::ImageRgb8(RgbImage::from_pixel(200, 300, Rgb([245, 245, 245])))
            .save(&light)
            .unwrap();
        DynamicImage::ImageRgb8(RgbImage::from_fn(200, 300, |x, y| {
            Rgb([((x * 7) % 255) as u8, ((y * 11) % 255) as u8, 80])
        }))
        .save(&patterned)
        .unwrap();

        let light_suggestion =
            suggest_batch_crop_sync(light.to_string_lossy().to_string(), 1440, 1920).unwrap();
        let patterned_suggestion =
            suggest_batch_crop_sync(patterned.to_string_lossy().to_string(), 1440, 1920).unwrap();

        assert!((light_suggestion.crop.x - patterned_suggestion.crop.x).abs() < 0.000_001);
        assert!((light_suggestion.crop.y - patterned_suggestion.crop.y).abs() < 0.000_001);
        assert!((light_suggestion.crop.width - patterned_suggestion.crop.width).abs() < 0.000_001);
        assert!(
            (light_suggestion.crop.height - patterned_suggestion.crop.height).abs() < 0.000_001
        );
        assert_eq!(
            light_suggestion.requires_review,
            patterned_suggestion.requires_review
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn filename_keeps_unicode_and_replaces_unsafe_characters() {
        assert_eq!(sanitize_stem("模特 01.final.png"), "模特 01.final");
    }

    #[test]
    fn export_writes_exact_jpeg_dimensions_without_overwriting() {
        let root = std::env::temp_dir().join(format!("lumina-batch-crop-test-{}", Uuid::new_v4()));
        let source = root.join("source.png");
        let output = root.join("output");
        std::fs::create_dir_all(&output).unwrap();
        DynamicImage::ImageRgb8(RgbImage::from_fn(120, 180, |x, y| {
            Rgb([(x % 255) as u8, (y % 255) as u8, 120])
        }))
        .save(&source)
        .unwrap();

        let payload = ExportBatchCropImagePayload {
            source_path: source.to_string_lossy().to_string(),
            file_name: "模特 01.png".to_string(),
            output_directory: output.to_string_lossy().to_string(),
            target_width: 1440,
            target_height: 1920,
            rotation_degrees: 0,
            crop: centered_crop(120, 180, 1440, 1920),
        };
        let first = export_batch_crop_image_sync(payload.clone()).unwrap();
        let second = export_batch_crop_image_sync(payload).unwrap();

        let exported = image::open(&first.output_path).unwrap();
        assert_eq!((exported.width(), exported.height()), (1440, 1920));
        assert_ne!(first.output_path, second.output_path);
        assert!(second.output_path.ends_with("_2.jpg"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn downscaled_export_applies_luminance_sharpening() {
        let root = std::env::temp_dir().join(format!("lumina-batch-crop-test-{}", Uuid::new_v4()));
        let source_path = root.join("source.png");
        let output = root.join("output");
        std::fs::create_dir_all(&output).unwrap();
        let source = RgbImage::from_fn(120, 160, |x, _| {
            if x < 60 {
                Rgb([70, 90, 110])
            } else {
                Rgb([150, 170, 190])
            }
        });
        DynamicImage::ImageRgb8(source.clone())
            .save(&source_path)
            .unwrap();

        let exported = export_batch_crop_image_sync(ExportBatchCropImagePayload {
            source_path: source_path.to_string_lossy().to_string(),
            file_name: "source.png".to_string(),
            output_directory: output.to_string_lossy().to_string(),
            target_width: 60,
            target_height: 80,
            rotation_degrees: 0,
            crop: centered_crop(120, 160, 60, 80),
        })
        .unwrap();
        let exported = image::open(exported.output_path).unwrap().to_rgb8();
        let resized = DynamicImage::ImageRgba8(
            resize_rgba_lanczos3(&DynamicImage::ImageRgb8(source), 60, 80).unwrap(),
        );
        let unsharpened = flatten_to_white(&resized);

        let exported_contrast = i16::from(rgb_luminance(exported.get_pixel(30, 40)))
            - i16::from(rgb_luminance(exported.get_pixel(29, 40)));
        let unsharpened_contrast = i16::from(rgb_luminance(unsharpened.get_pixel(30, 40)))
            - i16::from(rgb_luminance(unsharpened.get_pixel(29, 40)));

        assert!(exported_contrast > unsharpened_contrast);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pixel_crop_uses_an_exact_reduced_target_ratio() {
        let crop = NormalizedCropRect {
            x: 0.013,
            y: 0.027,
            width: 0.877,
            height: 0.659,
        };
        let (_, _, width, height) = resolve_pixel_crop(4013, 5999, &crop, 1440, 1920);
        assert_eq!(width * 4, height * 3);
    }

    #[test]
    fn pixel_count_limit_rejects_oversized_images() {
        assert_eq!(validate_image_dimensions(12_000, 10_000), Ok(()));
        assert_eq!(
            validate_image_dimensions(12_001, 10_000),
            Err("IMAGE_DIMENSIONS_TOO_LARGE".to_string())
        );
    }

    #[test]
    fn transparent_pixels_are_flattened_to_white() {
        let transparent = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([12, 34, 56, 0]),
        ));

        assert_eq!(
            flatten_to_white(&transparent).get_pixel(0, 0),
            &Rgb([255, 255, 255])
        );
    }

    #[test]
    fn luminance_usm_preserves_flat_color() {
        let source = RgbImage::from_pixel(9, 9, Rgb([80, 120, 160]));

        assert_eq!(sharpen_luminance_usm(&source), source);
    }

    #[test]
    fn luminance_usm_increases_edge_contrast_without_color_fringing() {
        let source = RgbImage::from_fn(9, 5, |x, _| {
            if x < 4 {
                Rgb([70, 90, 110])
            } else {
                Rgb([150, 170, 190])
            }
        });

        let sharpened = sharpen_luminance_usm(&source);
        let dark_edge = sharpened.get_pixel(3, 2);
        let light_edge = sharpened.get_pixel(4, 2);

        assert!(dark_edge[0] < source.get_pixel(3, 2)[0]);
        assert!(light_edge[0] > source.get_pixel(4, 2)[0]);
        assert_eq!(dark_edge[1] - dark_edge[0], 20);
        assert_eq!(dark_edge[2] - dark_edge[1], 20);
        assert_eq!(light_edge[1] - light_edge[0], 20);
        assert_eq!(light_edge[2] - light_edge[1], 20);
    }

    #[test]
    fn luminance_usm_threshold_suppresses_low_contrast_detail() {
        let source = RgbImage::from_fn(9, 5, |x, _| {
            let value = if x < 4 { 100 } else { 104 };
            Rgb([value, value, value])
        });

        assert_eq!(sharpen_luminance_usm(&source), source);
    }

    #[test]
    fn output_sharpening_only_runs_for_downscaling() {
        assert!(should_sharpen_after_resize(4660, 6213, 1440, 1920));
        assert!(!should_sharpen_after_resize(1440, 1920, 1440, 1920));
        assert!(!should_sharpen_after_resize(720, 960, 1440, 1920));
    }

    #[test]
    fn preview_assets_cap_dimensions_and_derive_a_small_thumbnail() {
        let root = std::env::temp_dir().join(format!("lumina-batch-crop-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let preview = root.join("preview.jpg");
        let thumbnail = root.join("thumbnail.jpg");
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(3200, 2000, Rgb([80, 120, 160])));

        write_preview_assets(&source, &preview, &thumbnail).unwrap();

        assert_eq!(image::image_dimensions(&preview).unwrap(), (2560, 1600));
        assert_eq!(image::image_dimensions(&thumbnail).unwrap(), (160, 100));
        std::fs::remove_dir_all(root).unwrap();
    }
}
