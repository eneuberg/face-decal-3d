import * as THREE from 'three';

/**
 * Keychain ring: a full torus in the world XY plane (axis along world Z).
 * Geometry is intentionally a complete donut — the user positions it so half
 * sits inside the model, half outside, and at print time the slicer unions
 * it with the body. The visible ("outside") half reads as a D from the
 * default front-on camera angle.
 *
 * Why a full torus instead of a half-torus:
 *   - A half-torus has open ends (non-manifold caps) which can confuse
 *     slicers; a full torus is a clean closed surface.
 *   - "Half inside the model and unioned" is the user's literal spec —
 *     a full ring is what gets unioned, the visible part is what reads as a D.
 *
 * Dimensions are specified in millimetres and converted to world units via
 * `worldPerMM`, so the visual size always matches the physical print size
 * the user has configured.
 */
export interface KeychainParams {
  /** Inner diameter of the loop, mm. The hole the chain passes through. */
  innerDiameterMM: number;
  /** Wall thickness (= tube diameter), mm. */
  wallThicknessMM: number;
  /** World units per millimetre — derived from the user's physical-size setting. */
  worldPerMM: number;
}

export const KEYCHAIN_DEFAULTS: Pick<KeychainParams, 'innerDiameterMM' | 'wallThicknessMM'> = {
  innerDiameterMM: 10,
  wallThicknessMM: 3,
};

export function buildKeychainGeometry(params: KeychainParams): THREE.BufferGeometry {
  const { innerDiameterMM, wallThicknessMM, worldPerMM } = params;
  const tubeR = (wallThicknessMM / 2) * worldPerMM;
  const innerR = (innerDiameterMM / 2) * worldPerMM;
  // Major radius = centerline of the tube. Inner edge is at majorR - tubeR = innerR ✓
  const majorR = innerR + tubeR;

  // Full donut in the XY plane (axis along world Z) — matches the camera's
  // default look direction so the visible half reads as a D.
  return new THREE.TorusGeometry(majorR, tubeR, 16, 64);
}

export function buildKeychainMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xb8b8c0,
    metalness: 0.7,
    roughness: 0.35,
  });
}

export function createKeychainMesh(params: KeychainParams): THREE.Mesh {
  const mesh = new THREE.Mesh(buildKeychainGeometry(params), buildKeychainMaterial());
  mesh.name = 'keychainRing';
  return mesh;
}

export function rebuildKeychainGeometry(mesh: THREE.Mesh, params: KeychainParams): void {
  mesh.geometry.dispose();
  mesh.geometry = buildKeychainGeometry(params);
}
