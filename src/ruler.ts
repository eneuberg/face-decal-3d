import * as THREE from 'three';
import type { SizeAxis } from './types';

/**
 * 3D ruler shown beside the model so the user can sanity-check the physical
 * size they typed in. Length on screen always matches the model along the
 * chosen axis; tick marks every 10 mm, longer ticks every 50 mm.
 *
 * The ruler is built out of LineSegments (no per-tick draw calls) and a tiny
 * sprite for the total-mm label so it stays readable at any zoom.
 */
export interface Ruler {
  group: THREE.Group;
  update: (params: RulerParams) => void;
  setVisible: (v: boolean) => void;
  dispose: () => void;
}

export interface RulerParams {
  bbox: THREE.Box3;
  axis: SizeAxis;
  totalMM: number;
}

const LINE_COLOR = 0x4af18a;
const TICK_MM = 10;
const MAJOR_EVERY = 5; // every 5th tick (50 mm) is a major tick

export function createRuler(): Ruler {
  const group = new THREE.Group();
  group.name = 'ruler';

  const lineMat = new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  });
  const lineGeom = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(lineGeom, lineMat);
  lines.renderOrder = 999; // draw on top so ruler is always visible
  group.add(lines);

  const labelSprite = makeLabelSprite('');
  group.add(labelSprite);

  const update = (params: RulerParams): void => {
    const { bbox, axis, totalMM } = params;
    if (totalMM <= 0) return;

    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const lengthWorld = size[axis];
    const worldPerMM = lengthWorld / totalMM;

    // Place the ruler beside the model along whichever axis we are NOT measuring.
    // For Y-axis measurement (default): put it to the +X side, at min Z.
    // For X-axis: put it to the +Y side, at min Z.
    // For Z-axis: put it to the +X side, at min Y.
    const offset = Math.max(size.x, size.y, size.z) * 0.15;
    const start = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const tickDir = new THREE.Vector3();

    if (axis === 'y') {
      start.set(bbox.max.x + offset, bbox.min.y, center.z);
      dir.set(0, 1, 0);
      tickDir.set(1, 0, 0);
    } else if (axis === 'x') {
      start.set(bbox.min.x, bbox.max.y + offset, center.z);
      dir.set(1, 0, 0);
      tickDir.set(0, 1, 0);
    } else {
      start.set(bbox.max.x + offset, center.y, bbox.min.z);
      dir.set(0, 0, 1);
      tickDir.set(1, 0, 0);
    }

    const tickLen = Math.max(lengthWorld * 0.04, offset * 0.4);
    const tickCount = Math.floor(totalMM / TICK_MM);

    const verts: number[] = [];
    // main bar
    const end = start.clone().addScaledVector(dir, lengthWorld);
    verts.push(start.x, start.y, start.z, end.x, end.y, end.z);

    for (let i = 0; i <= tickCount; i++) {
      const mm = i * TICK_MM;
      if (mm > totalMM) break;
      const len = i % MAJOR_EVERY === 0 ? tickLen : tickLen * 0.5;
      const p = start.clone().addScaledVector(dir, mm * worldPerMM);
      const q = p.clone().addScaledVector(tickDir, len);
      verts.push(p.x, p.y, p.z, q.x, q.y, q.z);
    }

    const arr = new Float32Array(verts);
    lineGeom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    lineGeom.computeBoundingSphere();

    // Label at the top of the bar.
    updateLabelSprite(labelSprite, `${formatMM(totalMM)} mm`);
    const labelPos = end.clone().addScaledVector(tickDir, tickLen * 1.5);
    labelSprite.position.copy(labelPos);
    // Sprite scale based on bbox extent so the label reads at a similar
    // apparent size across very different model scales.
    const spriteScale = Math.max(lengthWorld * 0.18, offset * 0.8);
    labelSprite.scale.set(spriteScale, spriteScale * 0.4, 1);
  };

  const setVisible = (v: boolean): void => {
    group.visible = v;
  };

  const dispose = (): void => {
    lineGeom.dispose();
    lineMat.dispose();
    disposeSprite(labelSprite);
    group.clear();
  };

  return { group, update, setVisible, dispose };
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 1000;
  sprite.userData['canvas'] = canvas;
  sprite.userData['ctxText'] = '';
  if (text) updateLabelSprite(sprite, text);
  return sprite;
}

function updateLabelSprite(sprite: THREE.Sprite, text: string): void {
  if (sprite.userData['ctxText'] === text) return;
  sprite.userData['ctxText'] = text;
  const canvas = sprite.userData['canvas'] as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 72px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#4af18a';
  ctx.fillText(text, 12, canvas.height / 2);
  const mat = sprite.material as THREE.SpriteMaterial;
  if (mat.map) mat.map.needsUpdate = true;
}

function disposeSprite(sprite: THREE.Sprite): void {
  const mat = sprite.material as THREE.SpriteMaterial;
  if (mat.map) mat.map.dispose();
  mat.dispose();
}

function formatMM(mm: number): string {
  if (mm >= 100) return mm.toFixed(0);
  return mm.toFixed(1);
}
