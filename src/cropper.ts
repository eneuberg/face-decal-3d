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

type DragMode =
  | { kind: 'none' }
  | { kind: 'move'; startX: number; startY: number; rect: Rect }
  | { kind: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; rect: Rect }
  | { kind: 'lasso' };

const HANDLE_SIZE = 10;
const LASSO_MIN_DIST_SQ = 4 * 4;
const LASSO_MIN_POINTS = 3;

const RECT_HINT = 'Drag corners to resize, drag inside to move.';
const LASSO_HINT = 'Drag to draw a freehand outline. Release to close the shape.';

export class Cropper {
  private modal = getRequiredEl<HTMLDivElement>('crop-modal');
  private canvas = getRequiredEl<HTMLCanvasElement>('crop-canvas');
  private confirmBtn = getRequiredEl<HTMLButtonElement>('crop-confirm');
  private cancelBtn = getRequiredEl<HTMLButtonElement>('crop-cancel');
  private rectModeBtn = getRequiredEl<HTMLButtonElement>('crop-mode-rect');
  private lassoModeBtn = getRequiredEl<HTMLButtonElement>('crop-mode-lasso');
  private hintEl = getRequiredEl<HTMLSpanElement>('crop-hint');

  private ctx: CanvasRenderingContext2D;
  private image: HTMLImageElement | null = null;
  private mode: CropMode = 'rect';

  /** Rectangle in canvas (display) coordinates. */
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  /** Lasso polygon in canvas (display) coordinates. */
  private lasso: Point[] = [];
  private lassoClosed = false;

  private drag: DragMode = { kind: 'none' };
  private resolveFn: ((value: HTMLCanvasElement | null) => void) | null = null;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire 2D context for crop canvas');
    this.ctx = ctx;

    this.confirmBtn.addEventListener('click', () => this.confirm());
    this.cancelBtn.addEventListener('click', () => this.cancel());
    this.rectModeBtn.addEventListener('click', () => this.setMode('rect'));
    this.lassoModeBtn.addEventListener('click', () => this.setMode('lasso'));

    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());
  }

  /** Open the modal with the given image; resolves with cropped canvas or null on cancel. */
  async open(file: File): Promise<HTMLCanvasElement | null> {
    const image = await loadImage(file);
    this.image = image;

    // Fit canvas inside max ~80vw / 70vh while preserving aspect ratio.
    const maxW = window.innerWidth * 0.8;
    const maxH = window.innerHeight * 0.7;
    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    this.canvas.width = Math.round(image.width * scale);
    this.canvas.height = Math.round(image.height * scale);

    this.resetRect();
    this.lasso = [];
    this.lassoClosed = false;
    this.setMode('rect');

    this.modal.classList.remove('hidden');
    this.modal.setAttribute('aria-hidden', 'false');
    this.draw();

    return new Promise<HTMLCanvasElement | null>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  private setMode(mode: CropMode): void {
    this.mode = mode;
    this.rectModeBtn.classList.toggle('active', mode === 'rect');
    this.lassoModeBtn.classList.toggle('active', mode === 'lasso');
    this.hintEl.textContent = mode === 'rect' ? RECT_HINT : LASSO_HINT;
    this.drag = { kind: 'none' };
    if (mode === 'lasso') {
      // Start fresh each time the user enters lasso mode.
      this.lasso = [];
      this.lassoClosed = false;
    }
    this.draw();
  }

  private resetRect(): void {
    if (!this.image) return;
    const shorter = Math.min(this.canvas.width, this.canvas.height);
    const side = shorter * 0.8;
    this.rect = {
      x: (this.canvas.width - side) / 2,
      y: (this.canvas.height - side) / 2,
      w: side,
      h: side,
    };
  }

  private confirm(): void {
    if (!this.image) {
      this.close(null);
      return;
    }
    const out =
      this.mode === 'rect' ? this.exportRect() : this.exportLasso();
    if (!out) {
      // Lasso with too few points or other failure — keep the modal open.
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

  // -------- Export --------

  private exportRect(): HTMLCanvasElement | null {
    if (!this.image) return null;
    const sx = this.image.width / this.canvas.width;
    const sy = this.image.height / this.canvas.height;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(this.rect.w * sx));
    out.height = Math.max(1, Math.round(this.rect.h * sy));
    const octx = out.getContext('2d');
    if (!octx) return null;
    octx.drawImage(
      this.image,
      this.rect.x * sx,
      this.rect.y * sy,
      this.rect.w * sx,
      this.rect.h * sy,
      0,
      0,
      out.width,
      out.height,
    );
    return out;
  }

  private exportLasso(): HTMLCanvasElement | null {
    if (!this.image || this.lasso.length < LASSO_MIN_POINTS) return null;

    const sx = this.image.width / this.canvas.width;
    const sy = this.image.height / this.canvas.height;

    // Polygon in image space.
    const poly = this.lasso.map((p) => ({ x: p.x * sx, y: p.y * sy }));
    const bbox = polygonBounds(poly);
    if (bbox.w < 1 || bbox.h < 1) return null;

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(bbox.w));
    out.height = Math.max(1, Math.round(bbox.h));
    const octx = out.getContext('2d');
    if (!octx) return null;

    // Clip to the polygon (translated so bbox top-left is at 0,0), then draw the image.
    octx.save();
    octx.beginPath();
    poly.forEach((p, i) => {
      const x = p.x - bbox.x;
      const y = p.y - bbox.y;
      if (i === 0) octx.moveTo(x, y);
      else octx.lineTo(x, y);
    });
    octx.closePath();
    octx.clip();
    octx.drawImage(this.image, -bbox.x, -bbox.y);
    octx.restore();
    return out;
  }

  // -------- Drawing --------

  private draw(): void {
    if (!this.image) return;
    const { ctx, canvas } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.image, 0, 0, canvas.width, canvas.height);

    if (this.mode === 'rect') this.drawRect();
    else this.drawLasso();
  }

  private drawRect(): void {
    const { ctx } = this;
    // Dim outside the rect.
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, this.canvas.width, this.canvas.height);
    ctx.rect(this.rect.x + this.rect.w, this.rect.y, -this.rect.w, this.rect.h);
    ctx.fill('evenodd');
    ctx.restore();

    ctx.strokeStyle = '#f0a040';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.rect.x + 0.5, this.rect.y + 0.5, this.rect.w, this.rect.h);

    ctx.fillStyle = '#f0a040';
    for (const c of corners(this.rect)) {
      ctx.fillRect(
        c.x - HANDLE_SIZE / 2,
        c.y - HANDLE_SIZE / 2,
        HANDLE_SIZE,
        HANDLE_SIZE,
      );
    }
  }

  private drawLasso(): void {
    const { ctx } = this;
    if (this.lasso.length === 0) return;

    // If closed, dim everything outside the polygon. While drawing, just show the path.
    if (this.lassoClosed) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, this.canvas.width, this.canvas.height);
      this.lasso.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.restore();
    }

    ctx.strokeStyle = '#f0a040';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.lasso.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    if (this.lassoClosed) ctx.closePath();
    ctx.stroke();
  }

  // -------- Input --------

  private onDown(e: MouseEvent): void {
    const { x, y } = this.localXY(e);
    if (this.mode === 'rect') {
      const corner = hitCorner(x, y, this.rect);
      if (corner) {
        this.drag = { kind: 'resize', corner, rect: { ...this.rect } };
        return;
      }
      if (insideRect(x, y, this.rect)) {
        this.drag = {
          kind: 'move',
          startX: x,
          startY: y,
          rect: { ...this.rect },
        };
      }
    } else {
      // Lasso: starting a new outline replaces any previous one.
      this.lasso = [{ x, y }];
      this.lassoClosed = false;
      this.drag = { kind: 'lasso' };
      this.draw();
    }
  }

  private onMove(e: MouseEvent): void {
    if (this.drag.kind === 'none') return;
    const { x, y } = this.localXY(e);

    if (this.drag.kind === 'move') {
      const dx = x - this.drag.startX;
      const dy = y - this.drag.startY;
      this.rect = clampRect(
        {
          x: this.drag.rect.x + dx,
          y: this.drag.rect.y + dy,
          w: this.drag.rect.w,
          h: this.drag.rect.h,
        },
        this.canvas.width,
        this.canvas.height,
      );
    } else if (this.drag.kind === 'resize') {
      this.rect = resizeFromCorner(
        this.drag.rect,
        this.drag.corner,
        x,
        y,
        this.canvas.width,
        this.canvas.height,
      );
    } else if (this.drag.kind === 'lasso') {
      const last = this.lasso[this.lasso.length - 1];
      if (!last || (x - last.x) ** 2 + (y - last.y) ** 2 >= LASSO_MIN_DIST_SQ) {
        this.lasso.push({
          x: clamp(x, 0, this.canvas.width),
          y: clamp(y, 0, this.canvas.height),
        });
      }
    }
    this.draw();
  }

  private onUp(): void {
    if (this.drag.kind === 'lasso') {
      this.lassoClosed = this.lasso.length >= LASSO_MIN_POINTS;
      this.draw();
    }
    this.drag = { kind: 'none' };
  }

  private localXY(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }
}

// -------- Helpers --------

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

function corners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x, y: r.y + r.h },
    { x: r.x + r.w, y: r.y + r.h },
  ];
}

function hitCorner(x: number, y: number, r: Rect): 'nw' | 'ne' | 'sw' | 'se' | null {
  const t = HANDLE_SIZE;
  if (Math.abs(x - r.x) <= t && Math.abs(y - r.y) <= t) return 'nw';
  if (Math.abs(x - (r.x + r.w)) <= t && Math.abs(y - r.y) <= t) return 'ne';
  if (Math.abs(x - r.x) <= t && Math.abs(y - (r.y + r.h)) <= t) return 'sw';
  if (Math.abs(x - (r.x + r.w)) <= t && Math.abs(y - (r.y + r.h)) <= t) return 'se';
  return null;
}

function insideRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function clampRect(r: Rect, maxW: number, maxH: number): Rect {
  const w = Math.min(r.w, maxW);
  const h = Math.min(r.h, maxH);
  const x = Math.max(0, Math.min(r.x, maxW - w));
  const y = Math.max(0, Math.min(r.y, maxH - h));
  return { x, y, w, h };
}

function resizeFromCorner(
  start: Rect,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  x: number,
  y: number,
  maxW: number,
  maxH: number,
): Rect {
  const minSize = 10;
  const cx = clamp(x, 0, maxW);
  const cy = clamp(y, 0, maxH);

  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  if (corner === 'nw') {
    left = Math.min(cx, right - minSize);
    top = Math.min(cy, bottom - minSize);
  } else if (corner === 'ne') {
    right = Math.max(cx, left + minSize);
    top = Math.min(cy, bottom - minSize);
  } else if (corner === 'sw') {
    left = Math.min(cx, right - minSize);
    bottom = Math.max(cy, top + minSize);
  } else {
    right = Math.max(cx, left + minSize);
    bottom = Math.max(cy, top + minSize);
  }

  return { x: left, y: top, w: right - left, h: bottom - top };
}

function polygonBounds(points: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
