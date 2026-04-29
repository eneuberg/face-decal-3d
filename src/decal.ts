import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import type { AppState, DecalPlacement } from './types';

/**
 * Project a decal onto the model from the current camera angle.
 * Returns true if a hit was found and the decal was placed.
 */
export function placeDecalAtPointer(
  state: AppState,
  pointer: { ndcX: number; ndcY: number },
  camera: THREE.Camera,
  parent: THREE.Object3D,
): boolean {
  if (!state.model || !state.decalTexture) return false;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(pointer.ndcX, pointer.ndcY), camera);
  const hits = raycaster.intersectObjects(state.model.meshes, false);

  const hit = hits[0];
  if (!hit || !(hit.object as THREE.Mesh).isMesh) return false;

  const orientation = new THREE.Euler().setFromRotationMatrix(camera.matrixWorld);

  const placement: DecalPlacement = {
    point: hit.point.clone(),
    orientation,
    targetMesh: hit.object as THREE.Mesh,
  };

  applyDecal(state, parent, placement, state.decalSize);
  state.decalPlacement = placement;
  return true;
}

/** Rebuild the decal at the cached placement with a new size. No-op if no placement. */
export function resizeDecal(state: AppState, parent: THREE.Object3D, size: number): void {
  state.decalSize = size;
  if (!state.decalPlacement) return;
  applyDecal(state, parent, state.decalPlacement, size);
}

/** Remove the active decal. */
export function clearDecal(state: AppState, parent: THREE.Object3D): void {
  if (state.decalMesh) {
    parent.remove(state.decalMesh);
    state.decalMesh.geometry.dispose();
    disposeMaterial(state.decalMesh.material);
    state.decalMesh = null;
  }
  state.decalPlacement = null;
}

function applyDecal(
  state: AppState,
  parent: THREE.Object3D,
  placement: DecalPlacement,
  size: number,
): void {
  if (!state.decalTexture) return;

  const sizeVec = new THREE.Vector3(size, size, size);
  const geometry = new DecalGeometry(
    placement.targetMesh,
    placement.point,
    placement.orientation,
    sizeVec,
  );

  const material = new THREE.MeshBasicMaterial({
    map: state.decalTexture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'faceDecal';

  if (state.decalMesh) {
    parent.remove(state.decalMesh);
    state.decalMesh.geometry.dispose();
    disposeMaterial(state.decalMesh.material);
  }

  parent.add(mesh);
  state.decalMesh = mesh;
}

function disposeMaterial(mat: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else mat.dispose();
}

// TODO: Multiple decals — track an array of placed decals, allow selecting/deleting individual ones
// TODO: Bake decal into UV texture — render to WebGLRenderTarget and export as a single-material mesh
// TODO: Decal rotation handle — let user rotate the decal around the surface normal
