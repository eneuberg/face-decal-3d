import { getRequiredEl } from './ui';

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type CropMode = 'rect' | 'lasso';
type SelectionOp = 'replace' | 'add' | 'sub';

type ActiveShape =
  | { kind: 'rect'; op: SelectionOp; start: Point; current: Point }
  | { kind: 'lasso'; op: SelectionOp; points: Point[] };

const LASSO_MIN_DIST_SQ = 4 * 4;
const LASSO_MIN_POINTS = 3;

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_FACTOR = 1.15;

const MAX_UNDO = 10;
/** Threshold above which a mask pixel is considered selected when packing for undo. */
const ALPHA_THRESHOLD = 127;
/** Mask fill color when restoring from a packed snapshot — must match SELECTION_FILL. */
const FILL_R = 240;
const FILL_G = 160;
const FILL_B = 64;

const VIEW_HINT = 'Ctrl+scroll = zoom, Space+drag = pan, dbl-click = reset view, Ctrl+Z = undo.';
const RECT_HINT = `Drag a rectangle. Shift = add, Alt = subtract. ${VIEW_HINT}`;
const LASSO_HINT = `Drag a freehand outline. Shift = add, Alt = subtract. ${VIEW_HINT}`;

const SELECTION_FILL = 'rgba(240,160,64,1)';

/**
 * Modal crop overlay with a mask-based selection model.
 *
 * The selection lives on an offscreen `maskCanvas` (alpha-only).
 * Each gesture (rect or lasso) bakes itself into the mask using a
 * `SelectionOp` captured at mouse-down from modifier keys:
 *   - no modifier → replace (clear + draw new shape)
 *   - Shift       → add (union)
 *   - Alt         → subtract (cut out)
 *
 * Confirm clips the source image by the mask and crops to the mask's
 * tight bounding box; pixels outside the mask become transparent.
 */
export class Cropper {
  private modal = getRequiredEl<HTMLDivElement>('crop-modal');
  private canvas = getRequiredEl<HTMLCanvasElement>('crop-canvas');
  private confirmBtn = getRequiredEl<HTMLButtonElement>('crop-confirm');
  private cancelBtn = getRequiredEl<HTMLButtonElement>('crop-cancel');
  private rectModeBtn = getRequiredEl<HTMLButtonElement>('crop-mode-rect');
  private lassoModeBtn = getRequiredEl<HTMLButtonElement>('crop-mode-lasso');
  private resetBtn = getRequiredEl<HTMLButtonElement>('crop-reset');
  private hintEl = getRequiredEl<HTMLSpanElement>('crop-hint');

  private ctx: CanvasRenderingContext2D;

  /** Mask canvas — same dimensions as the display canvas. Alpha = selected. */
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;

  /** Scratch canvas used to compose the dim-outside-selection overlay. */
  private overlayCanvas: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;

  private image: HTMLImageElement | null = null;
  private mode: CropMode = 'rect';
  private active: ActiveShape | null = null;

  // View transform for ctrl-zoom + space-drag pan. All shape and mask geometry
  // lives in image-display space; the transform is applied only at draw time
  // and inverted when reading mouse coords.
  private viewScale = 1;
  private viewOffsetX = 0;
  private viewOffsetY = 0;
  private spaceDown = false;
  private panActive = false;
  private panStart: { mx: number; my: number; ox: number; oy: number } | null = null;

  /** Packed 1-bit-per-pixel snapshots of the mask, oldest first. */
  private undoStack: Uint8Array[] = [];

  private resolveFn: ((value: HTMLCanvasElement | null) => void) | null = null;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire 2D context for crop canvas');
    this.ctx = ctx;

    this.maskCanvas = document.createElement('canvas');
    const mctx = this.maskCanvas.getContext('2d');
    if (!mctx) throw new Error('Failed to create mask context');
    this.maskCtx = mctx;

    this.overlayCanvas = document.createElement('canvas');
    const octx = this.overlayCanvas.getContext('2d');
    if (!octx) throw new Error('Failed to create overlay context');
    this.overlayCtx = octx;

    this.confirmBtn.addEventListener('click', () => this.confirm());
    this.cancelBtn.addEventListener('click', () => this.cancel());
    this.rectModeBtn.addEventListener('click', () => this.setMode('rect'));
    this.lassoModeBtn.addEventListener('click', () => this.setMode('lasso'));
    this.resetBtn.addEventListener('click', () => {
      this.pushUndo();
      this.resetMask(true);
    });

    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());

    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', () => this.resetView());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  private isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  /** Open the modal with the given image; resolves with cropped canvas or null on cancel. */
  async open(file: File): Promise<HTMLCanvasElement | null> {
    const image = await loadImage(file);
    this.image = image;

    // Fit canvas inside max ~80vw / 70vh while preserving aspect ratio.
    const maxW = window.innerWidth * 0.8;
    const maxH = window.innerHeight * 0.7;
    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    const w = Math.round(image.width * scale);
    const h = Math.round(image.height * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    this.maskCanvas.width = w;
    this.maskCanvas.height = h;
    this.overlayCanvas.width = w;
    this.overlayCanvas.height = h;

    this.active = null;
    this.undoStack = [];
    this.resetView();
    this.setMode('rect');
    this.resetMask(false);

    this.modal.classList.remove('hidden');
    this.modal.setAttribute('aria-hidden', 'false');
    this.draw();

    return new Promise<HTMLCanvasElement | null>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  /** Reset selection. If `clear` is false, pre-bake a centered default square. */
  private resetMask(clear: boolean): void {
    const { maskCtx, maskCanvas } = this;
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    if (!clear) {
      const shorter = Math.min(maskCanvas.width, maskCanvas.height);
      const side = shorter * 0.8;
      const x = (maskCanvas.width - side) / 2;
      const y = (maskCanvas.height - side) / 2;
      maskCtx.fillStyle = SELECTION_FILL;
      maskCtx.fillRect(x, y, side, side);
    }
    this.active = null;
    this.draw();
  }

  private setMode(mode: CropMode): void {
    this.mode = mode;
    this.rectModeBtn.classList.toggle('active', mode === 'rect');
    this.lassoModeBtn.classList.toggle('active', mode === 'lasso');
    this.hintEl.textContent = mode === 'rect' ? RECT_HINT : LASSO_HINT;
    this.active = null;
    this.draw();
  }

  // -------- Input --------

  private onDown(e: MouseEvent): void {
    if (!this.image) return;
    if (this.spaceDown) {
      // Start panning instead of drawing.
      const c = this.canvasXY(e);
      this.panActive = true;
      this.panStart = {
        mx: c.x,
        my: c.y,
        ox: this.viewOffsetX,
        oy: this.viewOffsetY,
      };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const p = this.localXY(e);
    const op = opFromModifiers(e);
    if (this.mode === 'rect') {
      this.active = { kind: 'rect', op, start: p, current: p };
    } else {
      this.active = { kind: 'lasso', op, points: [p] };
    }
    this.draw();
  }

  private onMove(e: MouseEvent): void {
    if (this.panActive && this.panStart) {
      const c = this.canvasXY(e);
      this.viewOffsetX = this.panStart.ox + (c.x - this.panStart.mx);
      this.viewOffsetY = this.panStart.oy + (c.y - this.panStart.my);
      this.draw();
      return;
    }
    if (!this.active) return;
    const p = clampPoint(this.localXY(e), this.canvas.width, this.canvas.height);
    if (this.active.kind === 'rect') {
      this.active.current = p;
    } else {
      const pts = this.active.points;
      const last = pts[pts.length - 1];
      if (!last || (p.x - last.x) ** 2 + (p.y - last.y) ** 2 >= LASSO_MIN_DIST_SQ) {
        pts.push(p);
      }
    }
    this.draw();
  }

  private onUp(): void {
    if (this.panActive) {
      this.panActive = false;
      this.panStart = null;
      this.canvas.style.cursor = this.spaceDown ? 'grab' : '';
      return;
    }
    if (!this.active) return;
    this.pushUndo();
    this.bakeActive();
    this.active = null;
    this.draw();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.image || !e.ctrlKey) return;
    e.preventDefault();
    const c = this.canvasXY(e);
    const oldScale = this.viewScale;
    const newScale = clamp(
      e.deltaY < 0 ? oldScale * ZOOM_FACTOR : oldScale / ZOOM_FACTOR,
      ZOOM_MIN,
      ZOOM_MAX,
    );
    if (newScale === oldScale) return;
    // Keep the image point under the cursor stationary on screen.
    const ix = (c.x - this.viewOffsetX) / oldScale;
    const iy = (c.y - this.viewOffsetY) / oldScale;
    this.viewScale = newScale;
    this.viewOffsetX = c.x - ix * newScale;
    this.viewOffsetY = c.y - iy * newScale;
    if (newScale === 1) {
      // Snap pan back to identity when fully zoomed out.
      this.viewOffsetX = 0;
      this.viewOffsetY = 0;
    }
    this.draw();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.isOpen()) return;
    if (e.code === 'Space' && !this.spaceDown) {
      this.spaceDown = true;
      if (!this.panActive) this.canvas.style.cursor = 'grab';
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      this.undo();
      e.preventDefault();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      this.spaceDown = false;
      if (!this.panActive) this.canvas.style.cursor = '';
    }
  }

  // -------- Undo --------

  private pushUndo(): void {
    this.undoStack.push(this.encodeMask());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.decodeMask(prev);
    this.active = null;
    this.draw();
  }

  /** Pack the mask's alpha channel as 1 bit per pixel. */
  private encodeMask(): Uint8Array {
    const w = this.maskCanvas.width;
    const h = this.maskCanvas.height;
    const data = this.maskCtx.getImageData(0, 0, w, h).data;
    const total = w * h;
    const bytes = new Uint8Array((total + 7) >> 3);
    for (let i = 0; i < total; i++) {
      const alpha = data[i * 4 + 3] ?? 0;
      if (alpha > ALPHA_THRESHOLD) {
        const byteIdx = i >> 3;
        const bit = 1 << (i & 7);
        bytes[byteIdx] = (bytes[byteIdx] ?? 0) | bit;
      }
    }
    return bytes;
  }

  /** Restore the mask canvas from a packed snapshot. */
  private decodeMask(bytes: Uint8Array): void {
    const w = this.maskCanvas.width;
    const h = this.maskCanvas.height;
    const img = this.maskCtx.createImageData(w, h);
    const px = img.data;
    const total = w * h;
    for (let i = 0; i < total; i++) {
      const byte = bytes[i >> 3] ?? 0;
      const bit = (byte >> (i & 7)) & 1;
      if (bit) {
        const o = i * 4;
        px[o] = FILL_R;
        px[o + 1] = FILL_G;
        px[o + 2] = FILL_B;
        px[o + 3] = 255;
      }
    }
    this.maskCtx.putImageData(img, 0, 0);
  }

  private resetView(): void {
    this.viewScale = 1;
    this.viewOffsetX = 0;
    this.viewOffsetY = 0;
    this.draw();
  }

  /** Bake the active shape into the mask using its captured op. */
  private bakeActive(): void {
    if (!this.active) return;
    const ctx = this.maskCtx;
    ctx.save();
    if (this.active.op === 'replace') {
      ctx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = SELECTION_FILL;
    } else if (this.active.op === 'add') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = SELECTION_FILL;
    } else {
      // 'sub' → erase wherever the new shape covers
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';
    }

    if (this.active.kind === 'rect') {
      const r = rectFromPoints(this.active.start, this.active.current);
      if (r.w >= 1 && r.h >= 1) ctx.fillRect(r.x, r.y, r.w, r.h);
    } else {
      const pts = this.active.points;
      if (pts.length >= LASSO_MIN_POINTS) {
        ctx.beginPath();
        pts.forEach((pt, i) => {
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // -------- Drawing --------

  private draw(): void {
    if (!this.image) return;
    const { ctx, canvas } = this;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(this.viewScale, 0, 0, this.viewScale, this.viewOffsetX, this.viewOffsetY);
    ctx.drawImage(this.image, 0, 0, canvas.width, canvas.height);

    // Build a dim-outside-selection overlay: 50% black, with the mask's alpha
    // erased so the selected region shows the underlying image at full brightness.
    const ov = this.overlayCtx;
    ov.save();
    ov.setTransform(1, 0, 0, 1, 0, 0);
    ov.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ov.fillStyle = 'rgba(0,0,0,0.5)';
    ov.fillRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ov.globalCompositeOperation = 'destination-out';
    ov.drawImage(this.maskCanvas, 0, 0);
    ov.restore();
    ctx.drawImage(this.overlayCanvas, 0, 0);

    if (this.active) this.drawActiveOutline();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawActiveOutline(): void {
    if (!this.active) return;
    const { ctx } = this;
    ctx.save();
    // Keep stroke widths and dash sizes constant in screen pixels regardless of zoom.
    const w = 1.5 / this.viewScale;
    const dash = (n: number): number[] => [n / this.viewScale, n / this.viewScale];
    ctx.lineWidth = w;
    if (this.active.op === 'sub') {
      ctx.strokeStyle = '#c14040';
      ctx.setLineDash(dash(4));
    } else {
      ctx.strokeStyle = '#f0a040';
      ctx.setLineDash(this.active.op === 'add' ? dash(2) : []);
    }
    if (this.active.kind === 'rect') {
      const r = rectFromPoints(this.active.start, this.active.current);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    } else {
      const pts = this.active.points;
      if (pts.length > 0) {
        ctx.beginPath();
        pts.forEach((pt, i) => {
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // -------- Confirm / export --------

  private confirm(): void {
    if (!this.image) {
      this.close(null);
      return;
    }
    const out = this.exportMasked();
    if (!out) {
      // Empty selection — keep the modal open so the user can draw something.
      return;
    }
    this.close(out);
  }

  private cancel(): void {
    this.close(null);
  }

  private close(value: HTMLCanvasElement | null): void {
    this.modal.classList.add('hidden');
    this.modal.setAttribute('aria-hidden', 'true');
    const fn = this.resolveFn;
    this.resolveFn = null;
    if (fn) fn(value);
  }

  private exportMasked(): HTMLCanvasElement | null {
    if (!this.image) return null;

    const data = this.maskCtx.getImageData(
      0,
      0,
      this.maskCanvas.width,
      this.maskCanvas.height,
    );
    const bbox = alphaBounds(data);
    if (!bbox) return null;

    const sx = this.image.width / this.canvas.width;
    const sy = this.image.height / this.canvas.height;
    const outW = Math.max(1, Math.round(bbox.w * sx));
    const outH = Math.max(1, Math.round(bbox.h * sy));

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const octx = out.getContext('2d');
    if (!octx) return null;

    // 1. Draw the relevant region of the source image into the output.
    octx.drawImage(
      this.image,
      bbox.x * sx,
      bbox.y * sy,
      bbox.w * sx,
      bbox.h * sy,
      0,
      0,
      outW,
      outH,
    );

    // 2. Clip by the mask alpha (destination-in: keep destination only where source has alpha).
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(
      this.maskCanvas,
      bbox.x,
      bbox.y,
      bbox.w,
      bbox.h,
      0,
      0,
      outW,
      outH,
    );
    octx.globalCompositeOperation = 'source-over';

    return out;
  }

  // -------- Helpers --------

  /** Mouse position in raw canvas-pixel coords (no view transform applied). */
  private canvasXY(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }

  /** Mouse position in image-display space (canvas-pixel coords minus view transform). */
  private localXY(e: MouseEvent): Point {
    const c = this.canvasXY(e);
    return {
      x: (c.x - this.viewOffsetX) / this.viewScale,
      y: (c.y - this.viewOffsetY) / this.viewScale,
    };
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

function opFromModifiers(e: MouseEvent): SelectionOp {
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'sub';
  return 'replace';
}

function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function clampPoint(p: Point, maxW: number, maxH: number): Point {
  return {
    x: Math.max(0, Math.min(p.x, maxW)),
    y: Math.max(0, Math.min(p.y, maxH)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Tight bounding box of all pixels with alpha > 0. Returns null if empty. */
function alphaBounds(data: ImageData): Rect | null {
  const { width, height } = data;
  const pixels = data.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha !== undefined && alpha > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
