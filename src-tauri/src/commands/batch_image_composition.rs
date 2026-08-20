use image::{DynamicImage, GenericImageView, GrayImage, Luma, RgbImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use uuid::Uuid;

use super::batch_image_crop::{
    apply_rotation, available_output_path, batch_cache_dir, flatten_to_white, load_oriented_image,
    resize_rgba_lanczos3, validate_source_path,
};

const MAX_RENDER_PIXELS: u64 = 120_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedCanvasCompositionPayload {
    source_path: String,
    file_name: String,
    target_width: u32,
    target_height: u32,
    rotation_degrees: i32,
    transform: FixedCanvasTransform,
    stretches: Vec<FixedCanvasStretchOperation>,
    result_source_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixedCanvasTransform {
    zoom: f64,
    pan: FixedCanvasPan,
}

#[derive(Debug, Clone, Deserialize)]
struct FixedCanvasPan {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct NormalizedCanvasRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FixedCanvasStretchDirection {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Debug, Clone, Deserialize)]
struct FixedCanvasStretchOperation {
    source: NormalizedCanvasRect,
    direction: FixedCanvasStretchDirection,
    amount: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedBatchFixedCanvas {
    rendered_path: String,
    blank_mask_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedBatchFixedCanvas {
    output_path: String,
}

fn validate_payload(payload: &FixedCanvasCompositionPayload) -> Result<(), String> {
    if payload.target_width == 0 || payload.target_height == 0 {
        return Err("INVALID_TARGET_SIZE".to_string());
    }
    if u64::from(payload.target_width).saturating_mul(u64::from(payload.target_height))
        > MAX_RENDER_PIXELS
    {
        return Err("IMAGE_DIMENSIONS_TOO_LARGE".to_string());
    }
    if !payload.transform.zoom.is_finite()
        || !(20.0..=200.0).contains(&payload.transform.zoom)
        || !payload.transform.pan.x.is_finite()
        || !payload.transform.pan.y.is_finite()
        || payload.transform.pan.x.abs() > 80.0
        || payload.transform.pan.y.abs() > 80.0
    {
        return Err("INVALID_FIXED_CANVAS_TRANSFORM".to_string());
    }
    for operation in &payload.stretches {
        let source = &operation.source;
        if !source.x.is_finite()
            || !source.y.is_finite()
            || !source.width.is_finite()
            || !source.height.is_finite()
            || source.x < 0.0
            || source.y < 0.0
            || source.width <= 0.0
            || source.height <= 0.0
            || source.x + source.width > 100.000_001
            || source.y + source.height > 100.000_001
            || !operation.amount.is_finite()
            || operation.amount <= 0.0
            || operation.amount > 100.0
        {
            return Err("INVALID_STRETCH_OPERATION".to_string());
        }
    }
    Ok(())
}

fn placed_image_rect(
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
    transform: &FixedCanvasTransform,
) -> (i64, i64, u32, u32) {
    let source_ratio = source_width.max(1) as f64 / source_height.max(1) as f64;
    let target_ratio = target_width.max(1) as f64 / target_height.max(1) as f64;
    let (base_width, base_height) = if source_ratio > target_ratio {
        (target_width as f64, target_width as f64 / source_ratio)
    } else {
        (target_height as f64 * source_ratio, target_height as f64)
    };
    let scale = transform.zoom / 100.0;
    let width = (base_width * scale).round().max(1.0) as u32;
    let height = (base_height * scale).round().max(1.0) as u32;
    let center_x = target_width as f64 * (0.5 + transform.pan.x / 100.0);
    let center_y = target_height as f64 * (0.5 + transform.pan.y / 100.0);
    (
        (center_x - width as f64 / 2.0).round() as i64,
        (center_y - height as f64 / 2.0).round() as i64,
        width,
        height,
    )
}

fn normalized_rect_to_pixels(
    rect: &NormalizedCanvasRect,
    width: u32,
    height: u32,
) -> Option<(u32, u32, u32, u32)> {
    let left = (rect.x / 100.0 * width as f64)
        .floor()
        .clamp(0.0, width as f64) as u32;
    let top = (rect.y / 100.0 * height as f64)
        .floor()
        .clamp(0.0, height as f64) as u32;
    let right = ((rect.x + rect.width) / 100.0 * width as f64)
        .ceil()
        .clamp(0.0, width as f64) as u32;
    let bottom = ((rect.y + rect.height) / 100.0 * height as f64)
        .ceil()
        .clamp(0.0, height as f64) as u32;
    (right > left && bottom > top).then_some((left, top, right - left, bottom - top))
}

fn stretch_destination(operation: &FixedCanvasStretchOperation) -> NormalizedCanvasRect {
    let source = &operation.source;
    match operation.direction {
        FixedCanvasStretchDirection::Left => NormalizedCanvasRect {
            x: source.x - operation.amount,
            y: source.y,
            width: source.width + operation.amount,
            height: source.height,
        },
        FixedCanvasStretchDirection::Right => NormalizedCanvasRect {
            x: source.x,
            y: source.y,
            width: source.width + operation.amount,
            height: source.height,
        },
        FixedCanvasStretchDirection::Top => NormalizedCanvasRect {
            x: source.x,
            y: source.y - operation.amount,
            width: source.width,
            height: source.height + operation.amount,
        },
        FixedCanvasStretchDirection::Bottom => NormalizedCanvasRect {
            x: source.x,
            y: source.y,
            width: source.width,
            height: source.height + operation.amount,
        },
    }
}

fn render_composition(
    source: &DynamicImage,
    payload: &FixedCanvasCompositionPayload,
) -> Result<RgbImage, String> {
    let target_width = payload.target_width;
    let target_height = payload.target_height;
    let mut base = RgbaImage::from_pixel(target_width, target_height, Rgba([255, 255, 255, 255]));
    let (left, top, placed_width, placed_height) = placed_image_rect(
        source.width(),
        source.height(),
        target_width,
        target_height,
        &payload.transform,
    );
    let placed = resize_rgba_lanczos3(source, placed_width, placed_height)?;
    image::imageops::overlay(&mut base, &placed, left, top);

    let stretch_source = base.clone();
    for operation in &payload.stretches {
        let Some((source_x, source_y, source_width, source_height)) =
            normalized_rect_to_pixels(&operation.source, target_width, target_height)
        else {
            continue;
        };
        let destination = stretch_destination(operation);
        let Some((destination_x, destination_y, destination_width, destination_height)) =
            normalized_rect_to_pixels(&destination, target_width, target_height)
        else {
            continue;
        };
        let source_patch = DynamicImage::ImageRgba8(
            stretch_source
                .view(source_x, source_y, source_width, source_height)
                .to_image(),
        );
        let resized = resize_rgba_lanczos3(&source_patch, destination_width, destination_height)?;
        image::imageops::overlay(
            &mut base,
            &resized,
            i64::from(destination_x),
            i64::from(destination_y),
        );
    }

    Ok(flatten_to_white(&DynamicImage::ImageRgba8(base)))
}

fn fill_mask_rect(mask: &mut GrayImage, left: i64, top: i64, width: u32, height: u32) {
    let mask_width = i64::from(mask.width());
    let mask_height = i64::from(mask.height());
    let start_x = left.clamp(0, mask_width) as u32;
    let start_y = top.clamp(0, mask_height) as u32;
    let end_x = left.saturating_add(i64::from(width)).clamp(0, mask_width) as u32;
    let end_y = top.saturating_add(i64::from(height)).clamp(0, mask_height) as u32;

    for y in start_y..end_y {
        for x in start_x..end_x {
            mask.put_pixel(x, y, Luma([0]));
        }
    }
}

fn render_blank_mask(
    source: &DynamicImage,
    payload: &FixedCanvasCompositionPayload,
) -> Result<GrayImage, String> {
    validate_payload(payload)?;
    let mut mask = GrayImage::from_pixel(payload.target_width, payload.target_height, Luma([255]));
    let (left, top, placed_width, placed_height) = placed_image_rect(
        source.width(),
        source.height(),
        payload.target_width,
        payload.target_height,
        &payload.transform,
    );
    fill_mask_rect(&mut mask, left, top, placed_width, placed_height);

    for operation in &payload.stretches {
        let destination = stretch_destination(operation);
        if let Some((x, y, width, height)) =
            normalized_rect_to_pixels(&destination, payload.target_width, payload.target_height)
        {
            fill_mask_rect(&mut mask, i64::from(x), i64::from(y), width, height);
        }
    }

    Ok(mask)
}

fn compose_ai_fill_result(
    base: &RgbImage,
    generated: &RgbImage,
    blank_mask: &GrayImage,
) -> Result<RgbImage, String> {
    if base.dimensions() != generated.dimensions() || base.dimensions() != blank_mask.dimensions() {
        return Err("AI_FILL_DIMENSIONS_MISMATCH".to_string());
    }

    let mut protected = base.clone();
    for (x, y, mask_pixel) in blank_mask.enumerate_pixels() {
        if mask_pixel[0] == 255 {
            protected.put_pixel(x, y, *generated.get_pixel(x, y));
        }
    }
    Ok(protected)
}

fn render_payload(payload: &FixedCanvasCompositionPayload) -> Result<RgbImage, String> {
    validate_payload(payload)?;
    if let Some(result_source_path) = payload
        .result_source_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let (source_path, _, _) = validate_source_path(result_source_path)?;
        let result = load_oriented_image(&source_path)?;
        let resized = DynamicImage::ImageRgba8(resize_rgba_lanczos3(
            &result,
            payload.target_width,
            payload.target_height,
        )?);
        return Ok(flatten_to_white(&resized));
    }

    let (source_path, _, _) = validate_source_path(&payload.source_path)?;
    let source = apply_rotation(load_oriented_image(&source_path)?, payload.rotation_degrees);
    render_composition(&source, payload)
}

fn write_jpeg(image: RgbImage, output_path: &Path) -> Result<(), String> {
    let output = File::create(output_path).map_err(|_| "OUTPUT_WRITE_FAILED".to_string())?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(output, 100);
    DynamicImage::ImageRgb8(image)
        .write_with_encoder(encoder)
        .map_err(|_| "OUTPUT_WRITE_FAILED".to_string())
}

fn write_png(image: GrayImage, output_path: &Path) -> Result<(), String> {
    let output = File::create(output_path).map_err(|_| "OUTPUT_WRITE_FAILED".to_string())?;
    let encoder = image::codecs::png::PngEncoder::new(output);
    DynamicImage::ImageLuma8(image)
        .write_with_encoder(encoder)
        .map_err(|_| "OUTPUT_WRITE_FAILED".to_string())
}

fn render_batch_fixed_canvas_sync(
    app: AppHandle,
    batch_id: String,
    payload: FixedCanvasCompositionPayload,
) -> Result<RenderedBatchFixedCanvas, String> {
    validate_payload(&payload)?;
    let (source_path, _, _) = validate_source_path(&payload.source_path)?;
    let source = apply_rotation(load_oriented_image(&source_path)?, payload.rotation_degrees);
    let base = render_composition(&source, &payload)?;
    let blank_mask = render_blank_mask(&source, &payload)?;
    let image = if let Some(result_source_path) = payload
        .result_source_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let (result_path, _, _) = validate_source_path(result_source_path)?;
        let generated = load_oriented_image(&result_path)?;
        let generated = DynamicImage::ImageRgba8(resize_rgba_lanczos3(
            &generated,
            payload.target_width,
            payload.target_height,
        )?);
        let generated = flatten_to_white(&generated);
        compose_ai_fill_result(&base, &generated, &blank_mask)?
    } else {
        base
    };
    let cache = batch_cache_dir(&app, &batch_id)?;
    let render_id = Uuid::new_v4().simple();
    let rendered_path = cache.join(format!("{render_id}-fixed-canvas.jpg"));
    let blank_mask_path = cache.join(format!("{render_id}-fixed-canvas-blank-mask.png"));
    write_jpeg(image, &rendered_path)?;
    write_png(blank_mask, &blank_mask_path)?;
    Ok(RenderedBatchFixedCanvas {
        rendered_path: rendered_path.to_string_lossy().to_string(),
        blank_mask_path: blank_mask_path.to_string_lossy().to_string(),
    })
}

fn export_batch_fixed_canvas_sync(
    output_directory: String,
    payload: FixedCanvasCompositionPayload,
) -> Result<ExportedBatchFixedCanvas, String> {
    validate_payload(&payload)?;
    let directory = PathBuf::from(output_directory);
    let metadata =
        std::fs::metadata(&directory).map_err(|_| "OUTPUT_DIRECTORY_NOT_FOUND".to_string())?;
    if !metadata.is_dir() {
        return Err("OUTPUT_DIRECTORY_NOT_FOUND".to_string());
    }
    let image = render_payload(&payload)?;
    let output_path = available_output_path(
        &directory,
        &payload.file_name,
        payload.target_width,
        payload.target_height,
    );
    write_jpeg(image, &output_path)?;
    Ok(ExportedBatchFixedCanvas {
        output_path: output_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn render_batch_fixed_canvas(
    app: AppHandle,
    batch_id: String,
    payload: FixedCanvasCompositionPayload,
) -> Result<RenderedBatchFixedCanvas, String> {
    tauri::async_runtime::spawn_blocking(move || {
        render_batch_fixed_canvas_sync(app, batch_id, payload)
    })
    .await
    .map_err(|error| format!("Fixed canvas render task failed: {error}"))?
}

#[tauri::command]
pub async fn export_batch_fixed_canvas(
    output_directory: String,
    payload: FixedCanvasCompositionPayload,
) -> Result<ExportedBatchFixedCanvas, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_batch_fixed_canvas_sync(output_directory, payload)
    })
    .await
    .map_err(|error| format!("Fixed canvas export task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    fn payload(target_width: u32, target_height: u32) -> FixedCanvasCompositionPayload {
        FixedCanvasCompositionPayload {
            source_path: String::new(),
            file_name: "source.png".to_string(),
            target_width,
            target_height,
            rotation_degrees: 0,
            transform: FixedCanvasTransform {
                zoom: 100.0,
                pan: FixedCanvasPan { x: 0.0, y: 0.0 },
            },
            stretches: Vec::new(),
            result_source_path: None,
        }
    }

    #[test]
    fn portrait_is_contained_on_a_square_white_canvas() {
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(100, 200, Rgb([20, 40, 60])));
        let rendered = render_composition(&source, &payload(200, 200)).unwrap();

        assert_eq!(rendered.dimensions(), (200, 200));
        assert_eq!(rendered.get_pixel(10, 100), &Rgb([255, 255, 255]));
        assert_eq!(rendered.get_pixel(100, 100), &Rgb([20, 40, 60]));
    }

    #[test]
    fn directional_stretch_extends_selected_pixels_into_the_blank_side() {
        let source = DynamicImage::ImageRgb8(RgbImage::from_fn(100, 200, |_, y| {
            if y < 100 {
                Rgb([30, 60, 90])
            } else {
                Rgb([90, 120, 150])
            }
        }));
        let mut input = payload(200, 200);
        input.stretches.push(FixedCanvasStretchOperation {
            source: NormalizedCanvasRect {
                x: 25.0,
                y: 0.0,
                width: 10.0,
                height: 100.0,
            },
            direction: FixedCanvasStretchDirection::Left,
            amount: 25.0,
        });

        let rendered = render_composition(&source, &input).unwrap();
        assert_ne!(rendered.get_pixel(5, 100), &Rgb([255, 255, 255]));
        assert_eq!(rendered.dimensions(), (200, 200));
    }

    #[test]
    fn blank_mask_uses_composition_geometry_after_pan_and_stretch() {
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(100, 200, Rgb([20, 40, 60])));
        let mut input = payload(200, 200);
        input.transform.pan.x = 10.0;
        input.stretches.push(FixedCanvasStretchOperation {
            source: NormalizedCanvasRect {
                x: 35.0,
                y: 0.0,
                width: 5.0,
                height: 100.0,
            },
            direction: FixedCanvasStretchDirection::Left,
            amount: 35.0,
        });

        let mask = render_blank_mask(&source, &input).unwrap();

        assert_eq!(mask.dimensions(), (200, 200));
        assert_eq!(mask.get_pixel(5, 100), &Luma([0]));
        assert_eq!(mask.get_pixel(100, 100), &Luma([0]));
        assert_eq!(mask.get_pixel(190, 100), &Luma([255]));
    }

    #[test]
    fn ai_result_cannot_replace_pixels_outside_the_blank_mask() {
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(100, 200, Rgb([20, 40, 60])));
        let input = payload(200, 200);
        let base = render_composition(&source, &input).unwrap();
        let mask = render_blank_mask(&source, &input).unwrap();
        let generated = RgbImage::from_pixel(200, 200, Rgb([220, 10, 30]));

        let protected = compose_ai_fill_result(&base, &generated, &mask).unwrap();

        assert_eq!(protected.get_pixel(100, 100), &Rgb([20, 40, 60]));
        assert_eq!(protected.get_pixel(10, 100), &Rgb([220, 10, 30]));
    }

    #[test]
    fn invalid_transform_is_rejected_before_rendering() {
        let mut input = payload(200, 200);
        input.transform.zoom = 0.0;
        assert_eq!(
            validate_payload(&input),
            Err("INVALID_FIXED_CANVAS_TRANSFORM".to_string())
        );
    }
}
