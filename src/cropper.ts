import { getRequiredEl } from './ui';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'move'; startX: number; startY: number; rect: Rect }
  | {
      kind: 'resize';
      corner: 'nw' | 'ne' | 'sw' | 'se';
      rect: Rect;
    };

const HANDLE_SIZE = 10;

export class Cropper {
  private modal = getRequiredEl<HTMLDivElement>('crop-modal');
  private canvas = getRequiredEl<HTMLCanvasElement>('crop-canvas');
  private confirmBtn = getRequiredEl<HTMLButtonElement>('crop-confirm');
  private cancelBtn = getRequiredEl<HTMLButtonElement>('crop-cancel');

  private ctx: CanvasRenderingContext2D;
  private image: HTMLImageElement | null = null;
  /** Rect in canvas (display) coordinates. */
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private drag: DragMode = { kind: 'none' };

  private resolveFn: ((value: HTMLCanvasElement | null) => void) | null = null;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire 2D context for crop canvas');
    this.ctx = ctx;

    this.confirmBtn.addEventListener('click', () => this.confirm());
    this.cancelBtn.addEventListener('click', () => this.cancel());
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

    // Default crop: centered square at 80% of shorter side.
    const shorter = Math.min(this.canvas.width, this.canvas.height);
    const side = shorter * 0.8;
    this.rect = {
      x: (this.canvas.width - side) / 2,
      y: (this.canvas.height - side) / 2,
      w: side,
      h: side,
    };

    this.modal.classList.remove('hidden');
    this.modal.setAttribute('aria-hidden', 'false');
    this.draw();

    return new Promise<HTMLCanvasElement | null>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  private confirm(): void {
    if (!this.image) {
      this.close(null);
      return;
    }
    // Map canvas-space rect → image-space rect.
    const sx = this.image.width / this.canvas.width;
    const sy = this.image.height / this.canvas.height;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(this.rect.w * sx));
    out.height = Math.max(1, Math.round(this.rect.h * sy));
    const octx = out.getContext('2d');
    if (!octx) {
      this.close(null);
      return;
    }
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

  private draw(): void {
    if (!this.image) return;
    const { ctx, canvas } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.image, 0, 0, canvas.width, canvas.height);

    // Dim everything outside the crop rectangle.
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(this.rect.x + this.rect.w, this.rect.y, -this.rect.w, this.rect.h);
    ctx.fill('evenodd');
    ctx.restore();

    // Crop border.
    ctx.strokeStyle = '#f0a040';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.rect.x + 0.5, this.rect.y + 0.5, this.rect.w, this.rect.h);

    // Corner handles.
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

  private onDown(e: MouseEvent): void {
    const { x, y } = this.localXY(e);
    const corner = hitCorner(x, y, this.rect);
    if (corner) {
      this.drag = { kind: 'resize', corner, rect: { ...this.rect } };
      return;
    }
    if (insideRect(x, y, this.rect)) {
      this.drag = { kind: 'move', startX: x, startY: y, rect: { ...this.rect } };
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
    }
    this.draw();
  }

  private onUp(): void {
    this.drag = { kind: 'none' };
  }

  private localXY(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
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

function corners(r: Rect): Array<{ x: number; y: number }> {
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
  const cx = Math.max(0, Math.min(x, maxW));
  const cy = Math.max(0, Math.min(y, maxH));

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
