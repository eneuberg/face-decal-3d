import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { LoadedModel } from './types';

/**
 * Export the model + optional decal as a single binary GLB.
 * The decal mesh is temporarily reparented under an export group so we don't
 * accidentally serialize lights / helpers from the live scene.
 */
export async function exportGLB(
  model: LoadedModel,
  decal: THREE.Mesh | null,
  filename = 'model_with_decal.glb',
): Promise<void> {
  const exportRoot = new THREE.Group();
  exportRoot.name = 'export';

  // Re-parent originals into the export group; restore them afterward.
  const modelOriginalParent = model.root.parent;
  exportRoot.add(model.root);

  const decalOriginalParent = decal?.parent ?? null;
  if (decal) exportRoot.add(decal);

  const exporter = new GLTFExporter();
  try {
    const result = await exporter.parseAsync(exportRoot, { binary: true });
    if (!(result instanceof ArrayBuffer)) {
      throw new Error('GLTFExporter did not return an ArrayBuffer');
    }
    triggerDownload(result, filename);
  } finally {
    if (modelOriginalParent) modelOriginalParent.add(model.root);
    if (decal && decalOriginalParent) decalOriginalParent.add(decal);
  }
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
