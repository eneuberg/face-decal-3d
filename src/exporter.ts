import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { cutModelAtY } from './csg';
import { createKeychainMesh, type KeychainParams } from './keychain';
import type { LoadedModel } from './types';

export type ExportFormat = 'glb' | 'stl';

export interface ExportOptions {
  format: ExportFormat;
  /** If set, geometry below `worldY` is removed (with a flat cap) before export. */
  cut: { worldY: number } | null;
  /** If set, a half-embedded torus keychain mesh is added at `positionWorld`. */
  keychain: { positionWorld: THREE.Vector3; params: KeychainParams } | null;
  /**
   * Conversion from world units to millimetres. The exported geometry is
   * scaled by `1 / worldPerMM` so 1 unit corresponds to 1 mm — which is what
   * common 3D-print slicers expect on import.
   */
  scale: { worldPerMM: number };
}

/**
 * Export the prepared model in the chosen format.
 *
 * GLB carries the decal mesh + materials and is round-trippable (glTF
 * viewers, Blender, etc). STL is mesh-only — no materials, no textures —
 * so the decal is intentionally omitted: a textureless DecalGeometry would
 * just be a thin shell hovering above the surface, which prints as junk
 * geometry.
 */
export async function exportModel(
  model: LoadedModel,
  decal: THREE.Mesh | null,
  filename: string,
  opts: ExportOptions,
): Promise<void> {
  const includeDecal = opts.format === 'glb';
  const exportRoot = buildExportRoot(model, includeDecal ? decal : null, opts);

  try {
    if (opts.format === 'glb') {
      const buf = await serializeGLB(exportRoot);
      triggerDownload(buf, filename, 'model/gltf-binary');
    } else {
      const buf = serializeSTL(exportRoot);
      triggerDownload(buf, filename, 'model/stl');
    }
  } finally {
    disposeRoot(exportRoot);
  }
}

/**
 * Build a fresh export root populated with cloned/derived geometry. Live
 * scene meshes are never reparented or mutated — we always work from copies
 * with world transforms baked into geometry, then scale everything to mm.
 */
function buildExportRoot(
  model: LoadedModel,
  decal: THREE.Mesh | null,
  opts: ExportOptions,
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'export';

  const modelMeshes = opts.cut
    ? cutModelAtY(model, opts.cut.worldY)
    : cloneMeshesWorldBaked(model);
  for (const m of modelMeshes) root.add(m);

  if (decal) {
    const decalClone = bakeMeshWorld(decal);
    decalClone.name = decal.name || 'faceDecal';
    root.add(decalClone);
  }

  if (opts.keychain) {
    const ring = createKeychainMesh(opts.keychain.params);
    ring.position.copy(opts.keychain.positionWorld);
    ring.updateMatrixWorld(true);
    ring.geometry.applyMatrix4(ring.matrixWorld);
    ring.position.set(0, 0, 0);
    ring.quaternion.identity();
    ring.scale.set(1, 1, 1);
    root.add(ring);
  }

  // Bake the mm scale into geometry so format-agnostic exporters all see
  // the right units (STLExporter doesn't honour ancestor transforms the way
  // GLTFExporter does, so applying it on the geometry is the safe path).
  const scale = 1 / Math.max(opts.scale.worldPerMM, 1e-9);
  if (Math.abs(scale - 1) > 1e-6) {
    const m = new THREE.Matrix4().makeScale(scale, scale, scale);
    for (const child of root.children) {
      if ((child as THREE.Mesh).isMesh) {
        (child as THREE.Mesh).geometry.applyMatrix4(m);
      }
    }
  }

  return root;
}

async function serializeGLB(root: THREE.Object3D): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('GLTFExporter did not return an ArrayBuffer');
  }
  return result;
}

function serializeSTL(root: THREE.Object3D): ArrayBuffer {
  const exporter = new STLExporter();
  const view = exporter.parse(root, { binary: true });
  // Slice from the underlying buffer in case the DataView covers a subrange.
  // STLExporter never returns SharedArrayBuffer-backed views, so the cast is safe.
  const buf = view.buffer as ArrayBuffer;
  return buf.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function cloneMeshesWorldBaked(model: LoadedModel): THREE.Mesh[] {
  return model.meshes.map(bakeMeshWorld);
}

function bakeMeshWorld(mesh: THREE.Mesh): THREE.Mesh {
  mesh.updateMatrixWorld(true);
  const baked = mesh.geometry.clone();
  baked.applyMatrix4(mesh.matrixWorld);
  const out = new THREE.Mesh(baked, mesh.material);
  out.name = mesh.name;
  return out;
}

function disposeRoot(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      (o as THREE.Mesh).geometry.dispose();
    }
  });
}

function triggerDownload(buffer: ArrayBuffer, filename: string, mime: string): void {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
