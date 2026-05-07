import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { LoadedModel } from './types';

/**
 * Trim every mesh in the model so only geometry above `cutWorldY` survives,
 * and add a flat cap at the cut. We do this by subtracting a tall axis-
 * aligned box (positioned strictly below the cut plane) from each mesh —
 * three-bvh-csg generates the cap automatically as part of the subtraction.
 *
 * The returned meshes have geometry baked into world space (no transforms);
 * the caller is expected to add them under a fresh export root, not back
 * into the live scene.
 *
 * Why per-mesh and not a single merged subtraction:
 *   - Models we get are usually multi-mesh with different materials. Doing
 *     them separately keeps materials intact 1:1.
 *   - CSG cost scales with complexity; many small ops beat one huge op.
 */
export function cutModelAtY(model: LoadedModel, cutWorldY: number): THREE.Mesh[] {
  const evaluator = new Evaluator();
  evaluator.useGroups = false; // keep result as one geometry per source mesh

  const out: THREE.Mesh[] = [];

  for (const mesh of model.meshes) {
    mesh.updateMatrixWorld(true);

    // Bake world transform into a geometry copy so the brush can sit at the
    // origin (CSG works in brush-local space; baking avoids matrix subtleties).
    const baked = mesh.geometry.clone();
    baked.applyMatrix4(mesh.matrixWorld);
    baked.computeBoundingBox();
    const bbox = baked.boundingBox;
    if (!bbox) {
      out.push(new THREE.Mesh(baked, mesh.material));
      continue;
    }

    // Cut plane below the mesh: nothing to subtract, return as-is.
    if (cutWorldY <= bbox.min.y) {
      out.push(new THREE.Mesh(baked, mesh.material));
      continue;
    }
    // Cut plane above the entire mesh: drop it (mesh is fully below cut).
    if (cutWorldY >= bbox.max.y) {
      baked.dispose();
      continue;
    }

    const meshBrush = new Brush(baked, mesh.material as THREE.Material);
    meshBrush.updateMatrixWorld();

    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    // Box dims: significantly wider than the mesh in X/Z so faces fully clear,
    // height = from below the mesh up to the cut plane.
    const margin = Math.max(size.x, size.z, 0.01) * 0.5;
    const boxW = size.x + margin * 2;
    const boxD = size.z + margin * 2;
    const belowMargin = Math.max(size.y * 0.1, 0.01);
    const boxBottom = bbox.min.y - belowMargin;
    const boxH = cutWorldY - boxBottom;
    const boxGeom = new THREE.BoxGeometry(boxW, boxH, boxD);
    boxGeom.translate(center.x, boxBottom + boxH / 2, center.z);
    const boxBrush = new Brush(boxGeom);
    boxBrush.updateMatrixWorld();

    const result = evaluator.evaluate(meshBrush, boxBrush, SUBTRACTION);
    result.name = mesh.name ? `${mesh.name}_cut` : 'mesh_cut';

    // Result geometry is in world space; ensure transforms are identity.
    result.position.set(0, 0, 0);
    result.quaternion.identity();
    result.scale.set(1, 1, 1);
    result.updateMatrixWorld(true);

    out.push(result);

    // Free intermediate geometries.
    boxGeom.dispose();
    baked.dispose();
  }

  return out;
}
