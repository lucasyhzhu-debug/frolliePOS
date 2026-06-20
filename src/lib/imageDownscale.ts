/** Center-crop + downscale an image File to a square webp Blob for product
 *  photos (v1.2 #3). Honors EXIF orientation so phone portrait shots don't
 *  upload sideways. Falls back to jpeg if webp encode is unsupported. */
export async function downscaleToWebp(file: File, size = 400): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("CANVAS_UNAVAILABLE");
  }
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  const webp = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/webp", 0.82),
  );
  if (webp) return webp;
  const jpeg = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/jpeg", 0.85),
  );
  if (!jpeg) throw new Error("ENCODE_FAILED");
  return jpeg;
}
