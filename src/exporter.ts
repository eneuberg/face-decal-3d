import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { cutModelAtY } from './csg';
import { createKeychainMesh, type KeychainParams } from './keychain';
import type { LoadedModel } from './types';

export interface ExportOptions {
  /** If set, geometry below `worldY` is removed (with a flat cap) before export. */
  cut: { worldY: number } | null;
  /** If set, a half-torus keychain mesh is added at `positionWorld`. */
  keychain: { positionWorld: THREE.Vector3; params: KeychainParams } | null;
  /**
   * Conversion from world units to millimetres. The exported geometry is
   * scaled by `1 / worldPerMM` so 1 unit in the GLB corresponds to 1 mm —
   * which is what every common 3D-print slicer expects when importing GLB.
   */
  scale: { worldPerMM: number };
}

/**
 * Export the model (+ optional decal, cut, keychain) as a single binary GLB.
 *
 * Pipeline:
 *   1. Build an export root group, populated with cloned/derived geometry —
 *      we never reparent or mutate the live scene meshes.
 *   2. If a cut is requested, run CSG against each mesh; otherwise clone
 *      the meshes with their world transforms baked in.
 *   3. If a decal exists, bake its world transform too and add it.
 *   4. If a keychain is requested, build a fresh half-torus, position it,
 *      and add it as a separate mesh (slicers union overlapping bodies).
 *   5. Scale the whole root so geometry is in mm.
 *   6. Serialize and trigger the download.
 */
export async function exportGLB(
  model: LoadedModel,
  decal: THREE.Mesh | null,
  filename: string,
  opts: ExportOptions,
): Promise<void> {
  const exportRoot = new THREE.Group();
  exportRoot.name = 'export';

  // --- Model meshes (cut or pass-through clones) ---
  const modelMeshes = opts.cut
    ? cutModelAtY(model, opts.cut.worldY)
    : cloneMeshesWorldBaked(model);
  for (const m of modelMeshes) exportRoot.add(m);

  // --- Decal ---
  if (decal) {
    const decalClone = bakeMeshWorld(decal);
    decalClone.name = decal.name || 'faceDecal';
    exportRoot.add(decalClone);
  }

  // --- Keychain ---
  if (opts.keychain) {
    const ring = createKeychainMesh(opts.keychain.params);
    ring.position.copy(opts.keychain.positionWorld);
    ring.updateMatrixWorld(true);
    // Bake the position into geometry so the export root can be scaled
    // uniformly at the end.
    ring.geometry.applyMatrix4(ring.matrixWorld);
    ring.position.set(0, 0, 0);
    ring.quaternion.identity();
    ring.scale.set(1, 1, 1);
    exportRoot.add(ring);
  }

  // --- Scale to mm so 1 unit = 1 mm in the GLB ---
  const scale = 1 / Math.max(opts.scale.worldPerMM, 1e-9);
  if (Math.abs(scale - 1) > 1e-6) {
    const m = new THREE.Matrix4().makeScale(scale, scale, scale);
    for (const child of exportRoot.children) {
      if ((child as THREE.Mesh).isMesh) {
        (child as THREE.Mesh).geometry.applyMatrix4(m);
      }
    }
  }

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(exportRoot, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('GLTFExporter did not return an ArrayBuffer');
  }
  triggerDownload(result, filename);

  // Free intermediate geometries.
  exportRoot.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      (o as THREE.Mesh).geometry.dispose();
    }
  });
}

/** Make a sibling-free copy of every model mesh with its world transform baked into geometry. */
function cloneMeshesWorldBaked(model: LoadedModel): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const mesh of model.meshes) {
    out.push(bakeMeshWorld(mesh));
  }
  return out;
}

function bakeMeshWorld(mesh: THREE.Mesh): THREE.Mesh {
  mesh.updateMatrixWorld(true);
  const baked = mesh.geometry.clone();
  baked.applyMatrix4(mesh.matrixWorld);
  const out = new THREE.Mesh(baked, mesh.material);
  out.name = mesh.name;
  return out;
}

function triggerDownload(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
