import * as THREE from 'three';
import './style.css';
import { Cropper } from './cropper';
import { clearDecal, placeDecalAtPointer, rebuildDecal } from './decal';
import { exportGLB } from './exporter';
import { createScene, loadModelFromFile } from './scene';
import { createInitialState } from './types';
import { getRequiredEl, setStatus, setStepActive } from './ui';

const SIZE_MIN = 0.01;
const SIZE_MAX = 1.0;
const STRETCH_MIN = 0.25;
const STRETCH_MAX = 4.0;
const WHEEL_FACTOR = 0.0015; // sensitivity for Shift+wheel resize

const state = createInitialState();

const viewport = getRequiredEl<HTMLElement>('viewport');
const sceneCtx = createScene(viewport);

const modelInput = getRequiredEl<HTMLInputElement>('model-input');
const imageInput = getRequiredEl<HTMLInputElement>('image-input');
const sizeSlider = getRequiredEl<HTMLInputElement>('size-slider');
const sizeValue = getRequiredEl<HTMLSpanElement>('size-value');
const stretchXSlider = getRequiredEl<HTMLInputElement>('stretch-x-slider');
const stretchXValue = getRequiredEl<HTMLSpanElement>('stretch-x-value');
const stretchYSlider = getRequiredEl<HTMLInputElement>('stretch-y-slider');
const stretchYValue = getRequiredEl<HTMLSpanElement>('stretch-y-value');
const redoBtn = getRequiredEl<HTMLButtonElement>('redo-projection');
const saveBtn = getRequiredEl<HTMLButtonElement>('save-btn');

const cropper = new Cropper();

setStepActive(1);
setStatus('Load a 3D model to begin.');

modelInput.addEventListener('change', async () => {
  const file = modelInput.files?.[0];
  if (!file) return;
  setStatus(`Loading ${file.name}…`);
  try {
    state.model = await loadModelFromFile(file, sceneCtx);
    clearDecal(state, sceneCtx.modelGroup);
    setStepActive(state.decalTexture ? 4 : 2);
    setStatus(
      state.decalTexture
        ? 'Model loaded. Click on it to place the decal.'
        : 'Model loaded. Now upload a face image.',
    );
    updateButtons();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load model: ${(err as Error).message}`, 'error');
  }
});

imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  try {
    setStepActive(3);
    setStatus('Crop the image, then click Confirm Crop.');
    const cropped = await cropper.open(file);
    if (!cropped) {
      setStatus('Crop cancelled.', 'warn');
      setStepActive(state.model ? 2 : 1);
      return;
    }
    if (state.decalTexture) state.decalTexture.dispose();
    const tex = new THREE.CanvasTexture(cropped);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    state.decalTexture = tex;

    // If there is already a placed decal, swap its texture in place.
    if (state.decalMesh) {
      const mat = state.decalMesh.material;
      if (!Array.isArray(mat) && 'map' in mat) {
        (mat as THREE.MeshBasicMaterial).map = tex;
        (mat as THREE.MeshBasicMaterial).needsUpdate = true;
      }
    }

    setStepActive(state.model ? 4 : 1);
    setStatus(
      state.model
        ? 'Image cropped. Click on the model to place the decal.'
        : 'Image cropped. Load a model to place it.',
    );
    updateButtons();
    // Reset file input so re-selecting the same file fires "change" again.
    imageInput.value = '';
  } catch (err) {
    console.error(err);
    setStatus(`Failed to crop image: ${(err as Error).message}`, 'error');
  }
});

// Click on viewport canvas → place decal.
sceneCtx.renderer.domElement.addEventListener('click', (e) => {
  if (!state.model) {
    setStatus('Load a model first.', 'warn');
    return;
  }
  if (!state.decalTexture) {
    setStatus('Upload and crop an image first.', 'warn');
    return;
  }

  const ndc = pointerToNDC(e, sceneCtx.renderer.domElement);
  const placed = placeDecalAtPointer(state, ndc, sceneCtx.camera, sceneCtx.modelGroup);
  if (!placed) {
    setStatus('No surface under cursor — try clicking on the model.', 'warn');
    return;
  }
  redoBtn.disabled = false;
  setStepActive(5);
  setStatus('Decal placed. Adjust size, click again to move, or save.');
  updateButtons();
});

// Shift + wheel over the viewport → live resize the active decal.
sceneCtx.renderer.domElement.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!e.shiftKey) return; // let OrbitControls handle plain wheel as zoom
    if (!state.decalPlacement) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = -e.deltaY * WHEEL_FACTOR;
    const next = clamp(state.decalSize * (1 + delta), SIZE_MIN, SIZE_MAX);
    setSize(next);
  },
  { passive: false },
);

sizeSlider.addEventListener('input', () => {
  const v = parseFloat(sizeSlider.value);
  if (Number.isFinite(v)) setSize(v);
});

stretchXSlider.addEventListener('input', () => {
  const v = parseFloat(stretchXSlider.value);
  if (Number.isFinite(v)) setStretchX(v);
});

stretchYSlider.addEventListener('input', () => {
  const v = parseFloat(stretchYSlider.value);
  if (Number.isFinite(v)) setStretchY(v);
});

redoBtn.addEventListener('click', () => {
  clearDecal(state, sceneCtx.modelGroup);
  redoBtn.disabled = true;
  setStepActive(4);
  setStatus('Click on the model to project again from the current camera angle.');
  updateButtons();
});

saveBtn.addEventListener('click', async () => {
  if (!state.model) return;
  setStatus('Exporting GLB…');
  try {
    await exportGLB(state.model, state.decalMesh);
    setStatus('Saved model_with_decal.glb');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to save GLB: ${(err as Error).message}`, 'error');
  }
});

function setSize(size: number): void {
  const clamped = clamp(size, SIZE_MIN, SIZE_MAX);
  state.decalSize = clamped;
  sizeSlider.value = clamped.toFixed(2);
  sizeValue.textContent = clamped.toFixed(2);
  rebuildDecal(state, sceneCtx.modelGroup);
}

function setStretchX(v: number): void {
  const clamped = clamp(v, STRETCH_MIN, STRETCH_MAX);
  state.decalStretchX = clamped;
  stretchXSlider.value = clamped.toFixed(2);
  stretchXValue.textContent = clamped.toFixed(2);
  rebuildDecal(state, sceneCtx.modelGroup);
}

function setStretchY(v: number): void {
  const clamped = clamp(v, STRETCH_MIN, STRETCH_MAX);
  state.decalStretchY = clamped;
  stretchYSlider.value = clamped.toFixed(2);
  stretchYValue.textContent = clamped.toFixed(2);
  rebuildDecal(state, sceneCtx.modelGroup);
}

function updateButtons(): void {
  saveBtn.disabled = !state.model;
  redoBtn.disabled = !state.decalMesh;
}

function pointerToNDC(
  e: MouseEvent,
  canvas: HTMLCanvasElement,
): { ndcX: number; ndcY: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    ndcX: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    ndcY: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
