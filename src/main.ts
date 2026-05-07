import * as THREE from 'three';
import './style.css';
import { Cropper } from './cropper';
import { CutController } from './cut';
import { clearDecal, placeDecalAtPointer, rebuildDecal } from './decal';
import { exportGLB, type ExportOptions } from './exporter';
import {
  KEYCHAIN_DEFAULTS,
  createKeychainMesh,
  rebuildKeychainGeometry,
} from './keychain';
import { createRuler } from './ruler';
import { createScene, loadModelFromFile } from './scene';
import { createInitialState, type PlacementSnapshot, type SizeAxis } from './types';
import { getRequiredEl, setStatus, setStepActive } from './ui';

const SIZE_MIN = 0.01;
const SIZE_MAX = 1.0;
const STRETCH_MIN = 0.25;
const STRETCH_MAX = 4.0;
const WHEEL_FACTOR = 0.0015;
const HISTORY_LIMIT = 10;

const PHYS_MIN_MM = 5;
const PHYS_MAX_MM = 500;

const state = createInitialState();

const viewport = getRequiredEl<HTMLElement>('viewport');
const sceneCtx = createScene(viewport);

// --- DOM refs ---
const modelInput = getRequiredEl<HTMLInputElement>('model-input');
const imageInput = getRequiredEl<HTMLInputElement>('image-input');

const sizeSlider = getRequiredEl<HTMLInputElement>('size-slider');
const sizeValue = getRequiredEl<HTMLSpanElement>('size-value');
const stretchXSlider = getRequiredEl<HTMLInputElement>('stretch-x-slider');
const stretchXValue = getRequiredEl<HTMLSpanElement>('stretch-x-value');
const stretchYSlider = getRequiredEl<HTMLInputElement>('stretch-y-slider');
const stretchYValue = getRequiredEl<HTMLSpanElement>('stretch-y-value');
const recropBtn = getRequiredEl<HTMLButtonElement>('recrop-btn');
const redoBtn = getRequiredEl<HTMLButtonElement>('redo-projection');
const saveBtn = getRequiredEl<HTMLButtonElement>('save-btn');

const physInput = getRequiredEl<HTMLInputElement>('phys-size-input');
const physAxisSel = getRequiredEl<HTMLSelectElement>('phys-axis-select');
const rulerToggle = getRequiredEl<HTMLInputElement>('ruler-toggle');

const cutToggle = getRequiredEl<HTMLInputElement>('cut-toggle');
const cutSlider = getRequiredEl<HTMLInputElement>('cut-slider');
const cutValue = getRequiredEl<HTMLSpanElement>('cut-value');
const cutResetBtn = getRequiredEl<HTMLButtonElement>('cut-reset-btn');

const keychainToggle = getRequiredEl<HTMLInputElement>('keychain-toggle');
const keychainXSlider = getRequiredEl<HTMLInputElement>('keychain-x-slider');
const keychainYSlider = getRequiredEl<HTMLInputElement>('keychain-y-slider');
const keychainZSlider = getRequiredEl<HTMLInputElement>('keychain-z-slider');
const keychainXValue = getRequiredEl<HTMLSpanElement>('keychain-x-value');
const keychainYValue = getRequiredEl<HTMLSpanElement>('keychain-y-value');
const keychainZValue = getRequiredEl<HTMLSpanElement>('keychain-z-value');
const keychainSnapBottomBtn = getRequiredEl<HTMLButtonElement>('keychain-snap-bottom-btn');
const keychainSnapTopBtn = getRequiredEl<HTMLButtonElement>('keychain-snap-top-btn');
const keychainSnapCutBtn = getRequiredEl<HTMLButtonElement>('keychain-snap-cut-btn');

// --- Subsystems ---
const cropper = new Cropper();
const cutCtl = new CutController();
const ruler = createRuler();
sceneCtx.scene.add(ruler.group);
ruler.setVisible(false);
let keychainMesh: THREE.Mesh | null = null;

// --- Global key handlers (decal undo + Shift-zoom suppression) ---
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') sceneCtx.controls.enableZoom = false;
});
window.addEventListener('keydown', (e) => {
  if (cropper.isOpen()) return;
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
  if (e.key.toLowerCase() !== 'z') return;
  if (!state.decalHistory.length) return;
  e.preventDefault();
  const snap = state.decalHistory.pop()!;
  state.decalPlacement = {
    point: snap.point,
    orientation: snap.orientation,
    targetMesh: snap.targetMesh,
  };
  setSize(snap.size);
  setStretchX(snap.stretchX);
  setStretchY(snap.stretchY);
  setStatus('Reverted decal to previous position.');
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') sceneCtx.controls.enableZoom = true;
});
window.addEventListener('blur', () => {
  sceneCtx.controls.enableZoom = true;
});

setStepActive(1);
setStatus('Load a 3D model to begin.');

// =====================================================================
// MODEL LOAD
// =====================================================================
modelInput.addEventListener('change', async () => {
  const file = modelInput.files?.[0];
  if (!file) return;
  setStatus(`Loading ${file.name}…`);
  try {
    // Tear down anything tied to the previous model first.
    cutCtl.detach();
    removeKeychain();
    state.cutEnabled = false;
    cutToggle.checked = false;
    state.keychainEnabled = false;
    keychainToggle.checked = false;

    state.model = await loadModelFromFile(file, sceneCtx);
    state.modelFilename = file.name;
    state.modelBBox = computeWorldBBox(state.model.root);
    clearDecal(state, sceneCtx.modelGroup);

    initPhysicalSizeForModel();
    initCutForModel();
    initKeychainPosForModel();
    refreshRuler();

    setStepActive(state.decalTexture ? 4 : 3);
    setStatus(
      state.decalTexture
        ? 'Model loaded. Click on it to place the decal, or skip to print prep.'
        : 'Model loaded. Set physical size, then add decal / cut / keychain as you like.',
    );
    updateButtons();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load model: ${(err as Error).message}`, 'error');
  }
});

// =====================================================================
// PHYSICAL SIZE
// =====================================================================
physInput.addEventListener('input', () => {
  const v = parseFloat(physInput.value);
  if (!Number.isFinite(v)) return;
  state.physicalSizeMM = clamp(v, PHYS_MIN_MM, PHYS_MAX_MM);
  physInput.value = String(state.physicalSizeMM);
  refreshRuler();
  refreshKeychainGeometry();
});

physAxisSel.addEventListener('change', () => {
  state.physicalSizeAxis = physAxisSel.value as SizeAxis;
  refreshRuler();
  refreshKeychainGeometry();
});

rulerToggle.addEventListener('change', () => {
  ruler.setVisible(rulerToggle.checked && state.modelBBox !== null);
});

function initPhysicalSizeForModel(): void {
  if (!state.modelBBox) return;
  // Sensible default: treat 1 world unit = 1 m (glTF convention) → mm. Snap
  // to a tidy number so the user doesn't see "183.4732 mm" sitting there.
  const size = state.modelBBox.getSize(new THREE.Vector3());
  const candidate = size[state.physicalSizeAxis] * 1000;
  const tidy = clamp(Math.round(candidate / 5) * 5, PHYS_MIN_MM, PHYS_MAX_MM);
  state.physicalSizeMM = tidy;
  physInput.value = String(tidy);
}

function refreshRuler(): void {
  if (!state.modelBBox) return;
  ruler.update({
    bbox: state.modelBBox,
    axis: state.physicalSizeAxis,
    totalMM: state.physicalSizeMM,
  });
  ruler.setVisible(rulerToggle.checked);
}

function worldPerMM(): number {
  if (!state.modelBBox) return 1;
  const size = state.modelBBox.getSize(new THREE.Vector3());
  const lengthWorld = size[state.physicalSizeAxis];
  return lengthWorld / state.physicalSizeMM;
}

// =====================================================================
// DECAL FLOW (largely unchanged)
// =====================================================================
imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  state.originalImageFile = file;
  try {
    setStatus('Crop the image, then click Confirm Crop.');
    const cropped = await cropper.open(file);
    if (!cropped) {
      setStatus('Crop cancelled.', 'warn');
      return;
    }
    applyCroppedTexture(cropped);
    setStepActive(state.model ? 4 : 1);
    setStatus(
      state.model
        ? 'Image cropped. Ctrl+click on the model to place the decal.'
        : 'Image cropped. Load a model to place it.',
    );
    updateButtons();
    imageInput.value = '';
  } catch (err) {
    console.error(err);
    setStatus(`Failed to crop image: ${(err as Error).message}`, 'error');
  }
});

recropBtn.addEventListener('click', async () => {
  if (!state.originalImageFile) return;
  try {
    setStatus('Re-crop and confirm to update the decal.');
    const cropped = await cropper.open(state.originalImageFile);
    if (!cropped) {
      setStatus('Re-crop cancelled.', 'warn');
      return;
    }
    applyCroppedTexture(cropped);
    rebuildDecal(state, sceneCtx.modelGroup);
    setStatus('Decal texture updated.');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to re-crop image: ${(err as Error).message}`, 'error');
  }
});

function applyCroppedTexture(cropped: HTMLCanvasElement): void {
  if (state.decalTexture) state.decalTexture.dispose();
  const tex = new THREE.CanvasTexture(cropped);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  state.decalTexture = tex;
  if (state.decalMesh) {
    const mat = state.decalMesh.material;
    if (!Array.isArray(mat) && 'map' in mat) {
      mat.map = tex;
      mat.needsUpdate = true;
    }
  }
}

sceneCtx.renderer.domElement.addEventListener('click', (e) => {
  if (!e.ctrlKey) return;
  if (!state.model) {
    setStatus('Load a model first.', 'warn');
    return;
  }
  if (!state.decalTexture) {
    setStatus('Upload and crop an image first (or skip — decal is optional).', 'warn');
    return;
  }
  const priorSnapshot = snapshotCurrentPlacement();
  const ndc = pointerToNDC(e, sceneCtx.renderer.domElement);
  const placed = placeDecalAtPointer(state, ndc, sceneCtx.camera, sceneCtx.modelGroup);
  if (!placed) {
    setStatus('No surface under cursor — try clicking on the model.', 'warn');
    return;
  }
  if (priorSnapshot) {
    state.decalHistory.push(priorSnapshot);
    if (state.decalHistory.length > HISTORY_LIMIT) state.decalHistory.shift();
  }
  redoBtn.disabled = false;
  setStatus('Decal placed. Ctrl+click to move, Ctrl+Z to undo.');
  updateButtons();
});

sceneCtx.renderer.domElement.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!e.shiftKey) return;
    if (!state.decalPlacement) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = -e.deltaY * WHEEL_FACTOR;
    setSize(clamp(state.decalSize * (1 + delta), SIZE_MIN, SIZE_MAX));
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
  setStatus('Click on the model to project again from the current camera angle.');
  updateButtons();
});

// =====================================================================
// CUT
// =====================================================================
cutToggle.addEventListener('change', () => {
  if (cutToggle.checked) enableCut();
  else disableCut();
});

cutSlider.addEventListener('input', () => {
  const v = parseFloat(cutSlider.value);
  if (!Number.isFinite(v)) return;
  state.cutWorldY = v;
  cutCtl.setHeight(v);
  cutValue.textContent = formatMM(worldYToMMFromBottom(v));
});

cutResetBtn.addEventListener('click', () => {
  if (!state.modelBBox) return;
  const y = state.modelBBox.min.y + state.modelBBox.getSize(new THREE.Vector3()).y * 0.25;
  state.cutWorldY = y;
  cutSlider.value = String(y);
  cutCtl.setHeight(y);
  cutValue.textContent = formatMM(worldYToMMFromBottom(y));
});

function initCutForModel(): void {
  if (!state.modelBBox) return;
  const size = state.modelBBox.getSize(new THREE.Vector3());
  cutSlider.min = String(state.modelBBox.min.y);
  cutSlider.max = String(state.modelBBox.max.y);
  cutSlider.step = String(size.y / 1000);
  state.cutWorldY = state.modelBBox.min.y + size.y * 0.25;
  cutSlider.value = String(state.cutWorldY);
  cutValue.textContent = formatMM(worldYToMMFromBottom(state.cutWorldY));
}

function enableCut(): void {
  if (!state.model || !state.modelBBox) return;
  state.cutEnabled = true;
  cutSlider.disabled = false;
  cutResetBtn.disabled = false;
  cutCtl.attach(state.model, sceneCtx.modelGroup, state.modelBBox, state.cutWorldY);
  cutValue.textContent = formatMM(worldYToMMFromBottom(state.cutWorldY));
  updateKeychainSnapAvailability();
  setStatus('Cut enabled — anything below the red plane will be removed on export.');
}

function disableCut(): void {
  state.cutEnabled = false;
  cutSlider.disabled = true;
  cutResetBtn.disabled = true;
  cutCtl.detach();
  cutValue.textContent = '—';
  updateKeychainSnapAvailability();
}

function worldYToMMFromBottom(worldY: number): number {
  if (!state.modelBBox) return 0;
  return (worldY - state.modelBBox.min.y) / worldPerMM();
}

// =====================================================================
// KEYCHAIN
// =====================================================================
keychainToggle.addEventListener('change', () => {
  if (keychainToggle.checked) enableKeychain();
  else disableKeychain();
});

keychainXSlider.addEventListener('input', () => updateKeychainFromSliders());
keychainYSlider.addEventListener('input', () => updateKeychainFromSliders());
keychainZSlider.addEventListener('input', () => updateKeychainFromSliders());

keychainSnapBottomBtn.addEventListener('click', () => snapKeychainCenteredTo('bottom'));
keychainSnapTopBtn.addEventListener('click', () => snapKeychainCenteredTo('top'));

keychainSnapCutBtn.addEventListener('click', () => {
  if (!state.cutEnabled) return;
  state.keychainPosWorld.y = state.cutWorldY;
  syncKeychainSlidersFromState();
  if (keychainMesh) keychainMesh.position.copy(state.keychainPosWorld);
});

function snapKeychainCenteredTo(edge: 'bottom' | 'top'): void {
  if (!state.modelBBox) return;
  const center = state.modelBBox.getCenter(new THREE.Vector3());
  const y = edge === 'bottom' ? state.modelBBox.min.y : state.modelBBox.max.y;
  state.keychainPosWorld.set(center.x, y, center.z);
  syncKeychainSlidersFromState();
  if (keychainMesh) keychainMesh.position.copy(state.keychainPosWorld);
}

function initKeychainPosForModel(): void {
  if (!state.modelBBox) return;
  const center = state.modelBBox.getCenter(new THREE.Vector3());
  state.keychainPosWorld.set(center.x, state.modelBBox.min.y, center.z);
  configureKeychainSliderRanges();
  syncKeychainSlidersFromState();
}

function configureKeychainSliderRanges(): void {
  if (!state.modelBBox) return;
  const size = state.modelBBox.getSize(new THREE.Vector3());
  const margin = Math.max(size.x, size.y, size.z) * 0.15;
  const setRange = (s: HTMLInputElement, min: number, max: number) => {
    s.min = String(min);
    s.max = String(max);
    s.step = String((max - min) / 1000);
  };
  setRange(keychainXSlider, state.modelBBox.min.x - margin, state.modelBBox.max.x + margin);
  setRange(keychainYSlider, state.modelBBox.min.y - margin, state.modelBBox.max.y + margin);
  setRange(keychainZSlider, state.modelBBox.min.z - margin, state.modelBBox.max.z + margin);
}

function syncKeychainSlidersFromState(): void {
  keychainXSlider.value = String(state.keychainPosWorld.x);
  keychainYSlider.value = String(state.keychainPosWorld.y);
  keychainZSlider.value = String(state.keychainPosWorld.z);
  refreshKeychainSliderLabels();
}

function refreshKeychainSliderLabels(): void {
  if (!state.modelBBox) {
    keychainXValue.textContent = '—';
    keychainYValue.textContent = '—';
    keychainZValue.textContent = '—';
    return;
  }
  const wpm = worldPerMM();
  keychainXValue.textContent = formatMM((state.keychainPosWorld.x - state.modelBBox.min.x) / wpm);
  keychainYValue.textContent = formatMM((state.keychainPosWorld.y - state.modelBBox.min.y) / wpm);
  keychainZValue.textContent = formatMM((state.keychainPosWorld.z - state.modelBBox.min.z) / wpm);
}

function updateKeychainFromSliders(): void {
  state.keychainPosWorld.set(
    parseFloat(keychainXSlider.value),
    parseFloat(keychainYSlider.value),
    parseFloat(keychainZSlider.value),
  );
  if (keychainMesh) keychainMesh.position.copy(state.keychainPosWorld);
  refreshKeychainSliderLabels();
}

function enableKeychain(): void {
  if (!state.model || !state.modelBBox) return;
  state.keychainEnabled = true;
  setKeychainSlidersDisabled(false);
  if (!keychainMesh) {
    keychainMesh = createKeychainMesh({
      ...KEYCHAIN_DEFAULTS,
      worldPerMM: worldPerMM(),
    });
    sceneCtx.modelGroup.add(keychainMesh);
  }
  keychainMesh.position.copy(state.keychainPosWorld);
  refreshKeychainSliderLabels();
  updateKeychainSnapAvailability();
  setStatus('Keychain ring added. Slide X/Y/Z to position it.');
}

function disableKeychain(): void {
  state.keychainEnabled = false;
  setKeychainSlidersDisabled(true);
  removeKeychain();
  updateKeychainSnapAvailability();
}

function setKeychainSlidersDisabled(disabled: boolean): void {
  keychainXSlider.disabled = disabled;
  keychainYSlider.disabled = disabled;
  keychainZSlider.disabled = disabled;
  keychainSnapBottomBtn.disabled = disabled;
  keychainSnapTopBtn.disabled = disabled;
}

function updateKeychainSnapAvailability(): void {
  keychainSnapCutBtn.disabled = !(state.keychainEnabled && state.cutEnabled);
}

function removeKeychain(): void {
  if (!keychainMesh) return;
  sceneCtx.modelGroup.remove(keychainMesh);
  keychainMesh.geometry.dispose();
  (keychainMesh.material as THREE.Material).dispose();
  keychainMesh = null;
}

function refreshKeychainGeometry(): void {
  if (!keychainMesh) return;
  rebuildKeychainGeometry(keychainMesh, {
    ...KEYCHAIN_DEFAULTS,
    worldPerMM: worldPerMM(),
  });
  refreshKeychainSliderLabels();
}

// =====================================================================
// SAVE
// =====================================================================
saveBtn.addEventListener('click', async () => {
  if (!state.model) return;
  const filename = buildExportFilename(state.modelFilename);
  setStatus(`Exporting ${filename}…`);
  try {
    const opts: ExportOptions = {
      cut: state.cutEnabled ? { worldY: state.cutWorldY } : null,
      keychain:
        state.keychainEnabled && keychainMesh
          ? {
              positionWorld: state.keychainPosWorld.clone(),
              params: { ...KEYCHAIN_DEFAULTS, worldPerMM: worldPerMM() },
            }
          : null,
      scale: { worldPerMM: worldPerMM() },
    };
    await exportGLB(state.model, state.decalMesh, filename, opts);
    setStatus(`Saved ${filename}`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to save GLB: ${(err as Error).message}`, 'error');
  }
});

function buildExportFilename(modelFilename: string | null): string {
  const stem = modelFilename ? modelFilename.replace(/\.(glb|gltf)$/i, '') : 'model';
  const tags: string[] = [];
  if (state.decalMesh) tags.push('decal');
  if (state.cutEnabled) tags.push('cut');
  if (state.keychainEnabled) tags.push('keychain');
  const suffix = tags.length ? `_${tags.join('_')}` : '';
  return `${stem}${suffix}.glb`;
}

// =====================================================================
// HELPERS
// =====================================================================
function setSize(size: number): void {
  const c = clamp(size, SIZE_MIN, SIZE_MAX);
  state.decalSize = c;
  sizeSlider.value = c.toFixed(2);
  sizeValue.textContent = c.toFixed(2);
  rebuildDecal(state, sceneCtx.modelGroup);
}
function setStretchX(v: number): void {
  const c = clamp(v, STRETCH_MIN, STRETCH_MAX);
  state.decalStretchX = c;
  stretchXSlider.value = c.toFixed(2);
  stretchXValue.textContent = c.toFixed(2);
  rebuildDecal(state, sceneCtx.modelGroup);
}
function setStretchY(v: number): void {
  const c = clamp(v, STRETCH_MIN, STRETCH_MAX);
  state.decalStretchY = c;
  stretchYSlider.value = c.toFixed(2);
  stretchYValue.textContent = c.toFixed(2);
  rebuildDecal(state, sceneCtx.modelGroup);
}

function updateButtons(): void {
  saveBtn.disabled = !state.model;
  redoBtn.disabled = !state.decalMesh;
  recropBtn.disabled = !state.originalImageFile;
  keychainToggle.disabled = !state.model;
  cutToggle.disabled = !state.model;
  if (!state.keychainEnabled) setKeychainSlidersDisabled(true);
  updateKeychainSnapAvailability();
}

function snapshotCurrentPlacement(): PlacementSnapshot | null {
  if (!state.decalPlacement) return null;
  return {
    point: state.decalPlacement.point.clone(),
    orientation: state.decalPlacement.orientation.clone(),
    targetMesh: state.decalPlacement.targetMesh,
    size: state.decalSize,
    stretchX: state.decalStretchX,
    stretchY: state.decalStretchY,
  };
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

function computeWorldBBox(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

function formatMM(mm: number): string {
  if (!Number.isFinite(mm)) return '—';
  if (Math.abs(mm) >= 100) return mm.toFixed(0);
  return mm.toFixed(1);
}
