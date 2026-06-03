// No-op stub for the native `canvas` module (see package.json in this dir).
//
// esc-pos-encoder lazy-requires `canvas` only inside its `.image()` method,
// which Frollie's src/lib/escpos.ts never calls. This stub resolves cleanly at
// import time (so esc-pos-encoder / canvas-dither / canvas-flatten load fine)
// and only throws if someone ACTUALLY tries to rasterize an image — making the
// omission loud rather than a silent blank, if logo printing is ever added.
function unavailable() {
  throw new Error(
    "canvas is stubbed out in Frollie POS (tools/stub-canvas): thermal image/.image() " +
      "rasterization is not bundled. Re-add the real `canvas` dependency to use it.",
  );
}

module.exports = {
  createCanvas: unavailable,
  loadImage: unavailable,
  Image: unavailable,
  ImageData: unavailable,
  Canvas: unavailable,
  registerFont: unavailable,
};
