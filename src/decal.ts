import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import type { AppState, DecalPlacement } from './types';

/**
 * Distance along each vertex normal to push the decal off the underlying
 * surface. polygonOffset isn't preserved by GLTFExporter, so we bake the
 * offset into the geometry to avoid z-fighting in glTF viewers. Tiny —
 * imperceptible visually — but enough to win the depth test reliably.
 */
const SURFACE_OFFSET = 0.001;

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

  applyDecal(state, parent, placement);
  state.decalPlacement = placement;
  return true;
}

/** Rebuild the decal at the cached placement using the current size + stretch state. No-op if no placement. */
export function rebuildDecal(state: AppState, parent: THREE.Object3D): void {
  if (!state.decalPlacement) return;
  applyDecal(state, parent, state.decalPlacement);
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
): void {
  if (!state.decalTexture) return;

  const base = state.decalSize;
  const sizeVec = new THREE.Vector3(
    base * state.decalStretchX,
    base * state.decalStretchY,
    base,
  );
  const geometry = new DecalGeometry(
    placement.targetMesh,
    placement.point,
    placement.orientation,
    sizeVec,
  );
  offsetAlongNormals(geometry, SURFACE_OFFSET);

  // We want the decal to look "unlit" — the photo's own colors, no shading
  // from the scene's lights. MeshBasicMaterial exports as KHR_materials_unlit,
  // but viewers built on VTK (f3d, ParaView) don't fully support that
  // extension and fall back to a default white PBR material — the texture
  // is dropped on the floor.
  //
  // Instead: use MeshStandardMaterial (the canonical glTF PBR material) and
  // route the texture through `emissiveMap`, with `color: black` zeroing the
  // lit contribution and `emissive: white` driving the visible output. The
  // base map is still bound for its alpha channel (alphaTest needs it). The
  // exported glTF uses pbrMetallicRoughness — no extensions, supported
  // everywhere — and the result is visually identical to unlit.
  //
  // alphaTest (not transparent) keeps the clean cutout: the exporter writes
  // alphaMode='MASK', so transparent fragments are discarded with no depth
  // write or blending. Plain transparent materials export as 'BLEND' and
  // since glTF has no equivalent for depthWrite=false, the decal would
  // occlude the model wherever its texture is transparent — the "white
  // card over the face" bug.
  const material = new THREE.MeshStandardMaterial({
    map: state.decalTexture,
    emissiveMap: state.decalTexture,
    emissive: new THREE.Color(0xffffff),
    color: new THREE.Color(0x000000),
    metalness: 0,
    roughness: 1,
    alphaTest: 0.5,
    transparent: false,
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

/** Push every vertex along its normal by `offset` world units. */
function offsetAlongNormals(geom: THREE.BufferGeometry, offset: number): void {
  const positions = geom.getAttribute('position') as THREE.BufferAttribute;
  const normals = geom.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    positions.setXYZ(
      i,
      positions.getX(i) + normals.getX(i) * offset,
      positions.getY(i) + normals.getY(i) * offset,
      positions.getZ(i) + normals.getZ(i) * offset,
    );
  }
  positions.needsUpdate = true;
}

// TODO: Multiple decals — track an array of placed decals, allow selecting/deleting individual ones
// TODO: Bake decal into UV texture — render to WebGLRenderTarget and export as a single-material mesh
// TODO: Decal rotation handle — let user rotate the decal around the surface normal
