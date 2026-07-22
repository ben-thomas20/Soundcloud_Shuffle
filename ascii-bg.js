'use strict';

// Dynamic pixel backdrop. The source photo is the currently playing track's
// artwork: we sample it into a grid of cells, then draw one dim square "pixel"
// per cell whose brightness tracks the cell's luminance, with a slow shimmer
// sweep. Canvas2D only, no deps. bgMode is "none", so cells are transparent and
// the panel background shows through, keeping it well behind the UI.
window.AsciiBackground = (function () {
  'use strict';

  const CFG = {
    cellSize: 6,
    coverage: 100,      // percent of cells eligible to draw
    contrast: 150,      // 100 is neutral
    brightness: 0,      // additive, -100..100 scaled to luminance
    grayscale: 100,     // fully monochrome, so pixels are a fixed gray
    invert: false,
    animStyle: 'shimmer',
    animSpeed: 100,     // 0..100
    animIntensity: 30,  // 0..100
    pixelAlpha: 0.3,    // overall backdrop strength; lower is dimmer
  };

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
    ctx.fillStyle = '#cfcfcf';

    const speed = 0.0016 * CFG.animSpeed / 100;
    const amp = 0.6 * CFG.animIntensity / 100;
    const p = now * speed;
    const cov = CFG.coverage / 100;
    // Leave a 1px gap only for chunky cells; small cells stay solid for detail.
    const size = cell >= 6 ? cell - 1 : cell;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let l = lum[y * cols + x];
        // shimmer: a diagonal brightness band sweeping across the grid.
        const sh = 1 + amp * Math.sin((x + y) * 0.28 - p);
        l = l * sh;
        if (l <= 0) continue;
        if (cov < 1 && hash(x, y) > cov) continue;
        const a = l * CFG.pixelAlpha;
        if (a < 0.04) continue;         // skip near-empty cells: faster and cleaner
        ctx.globalAlpha = a > 1 ? 1 : a;
        ctx.fillRect(x * cell, y * cell, size, size);
      }
    }
    ctx.globalAlpha = 1;
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
