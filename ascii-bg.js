'use strict';

// Self-contained reimplementation of the 21st.dev "Minimal" ASCII effect,
// pinned to the "hexdump" preset the panel ships with. Canvas2D only, no deps,
// nothing pulled in from the reference project.
//
// The source photo is the currently playing track's artwork: we sample it into
// a grid of cells, map each cell's luminance to a hex glyph, and animate a
// shimmer sweep across the grid with a faint halftone sheen on top. bgMode is
// "none", so nothing is drawn behind the glyphs and the panel background shows
// through the transparent cells.
window.AsciiBackground = (function () {
  'use strict';

  // The subset of the full parameter set that this preset actually exercises.
  // Neutral/disabled parameters (tint at 0 opacity, blur off, most pfx off) are
  // intentionally omitted rather than implemented as no-ops.
  const CFG = {
    cellSize: 8,
    coverage: 100,      // percent of cells eligible to draw
    contrast: 150,      // 100 is neutral
    brightness: 0,      // additive, -100..100 scaled to luminance
    grayscale: 100,     // fully monochrome, so glyph color is a fixed gray
    invert: false,
    animStyle: 'shimmer',
    animSpeed: 100,     // 0..100
    animIntensity: 60,  // 0..100
    halftone: 30,       // pfx.halftone intensity, 0..100
    glyphAlpha: 0.6,    // overall backdrop strength, keeps it behind the UI
  };

  const HEX = '0123456789abcdef';

  let canvas, ctx;
  let cols = 0;
  let rows = 0;
  const cell = CFG.cellSize;
  let lum = null;          // Float32Array, one adjusted luminance per cell
  let sourceBitmap = null;
  let hasImage = false;
  let raf = 0;
  let last = 0;

  // Offscreen sampler. willReadFrequently because we read it back every time
  // the source or the grid dimensions change.
  const sampler = document.createElement('canvas');
  const sctx = sampler.getContext('2d', { willReadFrequently: true });

  function resize() {
    if (!canvas) return;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    cols = Math.max(1, Math.ceil(w / cell));
    rows = Math.max(1, Math.ceil(h / cell));
    if (hasImage) sample();
    else procedural();
    // Font/baseline reset because setting canvas.width clears all state.
    ctx.font = `${cell}px ui-monospace, "SFMono-Regular", Menlo, monospace`;
    ctx.textBaseline = 'top';
  }

  // Downscaling the source to exactly cols x rows makes each destination pixel
  // the box average of one grid cell. That is the per-cell sample we want, and
  // it lets the browser do the averaging instead of us looping full-res pixels.
  function sample() {
    sampler.width = cols;
    sampler.height = rows;
    sctx.clearRect(0, 0, cols, rows);
    sctx.drawImage(sourceBitmap, 0, 0, cols, rows);
    const data = sctx.getImageData(0, 0, cols, rows).data;
    lum = new Float32Array(cols * rows);
    const k = CFG.contrast / 100;
    const b = CFG.brightness / 100;
    for (let i = 0; i < cols * rows; i++) {
      const o = i * 4;
      let l = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
      l = (l - 0.5) * k + 0.5 + b;        // contrast about mid-gray, then brightness
      if (CFG.invert) l = 1 - l;
      lum[i] = l < 0 ? 0 : l > 1 ? 1 : l;
    }
  }

  // Fallback field so the backdrop is alive before any artwork has loaded and
  // if artwork ever fails to fetch.
  function procedural() {
    lum = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = 0.5 + 0.5 * Math.sin(x * 0.18) * Math.cos(y * 0.16);
        lum[y * cols + x] = v * 0.55;
      }
    }
  }

  function setSource(bitmap) {
    sourceBitmap = bitmap;
    hasImage = true;
    if (cols && rows) sample();
  }

  // Deterministic per-cell value in 0..1, used only to thin cells when coverage
  // is below 100 so the same cells drop out every frame (no flicker).
  function hash(x, y) {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 40) return;   // ~24fps is plenty for a backdrop and saves CPU
    last = now;
    if (!lum) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#d8d8d8';

    const speed = 0.0016 * CFG.animSpeed / 100;
    const amp = 0.6 * CFG.animIntensity / 100;
    const p = now * speed;
    const cov = CFG.coverage / 100;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let l = lum[y * cols + x];
        // shimmer: a diagonal brightness band sweeping across the grid. It
        // nudges cells across glyph thresholds, so the hex digits also churn.
        const sh = 1 + amp * Math.sin((x + y) * 0.28 - p);
        l = l * sh;
        if (l <= 0) continue;
        if (cov < 1 && hash(x, y) > cov) continue;
        const a = l * CFG.glyphAlpha;
        if (a < 0.05) continue;         // skip near-empty cells: faster and cleaner
        ctx.globalAlpha = a > 1 ? 1 : a;
        const idx = l >= 1 ? 15 : (l * 16) | 0;
        ctx.fillText(HEX[idx < 0 ? 0 : idx], x * cell, y * cell);
      }
    }
    ctx.globalAlpha = 1;

    // Halftone sheen: faint white dots sized by cell luminance on a coarse
    // grid, so it reads as texture rather than per-cell noise.
    if (CFG.halftone > 0) {
      const step = 2;
      const maxR = cell * 0.42;
      const ha = 0.05 * CFG.halftone / 30;
      ctx.fillStyle = `rgba(255,255,255,${ha})`;
      for (let y = 0; y < rows; y += step) {
        for (let x = 0; x < cols; x += step) {
          const r = lum[y * cols + x] * maxR;
          if (r < 0.4) continue;
          ctx.beginPath();
          ctx.arc(x * cell + cell / 2, y * cell + cell / 2, r, 0, 6.2832);
          ctx.fill();
        }
      }
    }
  }

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    // The side panel can be dragged wider/narrower; re-sample on that too.
    if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  return { init, setSource };
})();
