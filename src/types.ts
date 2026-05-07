import * as THREE from 'three';

export interface LoadedModel {
  root: THREE.Group;
  meshes: THREE.Mesh[];
}

export interface DecalPlacement {
  point: THREE.Vector3;
  orientation: THREE.Euler;
  targetMesh: THREE.Mesh;
}

/** Captured state needed to fully restore a prior decal placement via undo. */
export interface PlacementSnapshot {
  point: THREE.Vector3;
  orientation: THREE.Euler;
  targetMesh: THREE.Mesh;
  size: number;
  stretchX: number;
  stretchY: number;
}

/** Which world-space axis maps to the user's physical-size measurement. */
export type SizeAxis = 'x' | 'y' | 'z';

export interface AppState {
  model: LoadedModel | null;
  /** Original filename of the loaded model, used to derive the export name. */
  modelFilename: string | null;
  /** Bounding box of the loaded model in world coordinates, captured at load. */
  modelBBox: THREE.Box3 | null;

  // --- Decal flow ---
  /** The original uploaded image File, kept around so the user can re-crop without re-uploading. */
  originalImageFile: File | null;
  decalTexture: THREE.CanvasTexture | null;
  decalMesh: THREE.Mesh | null;
  decalPlacement: DecalPlacement | null;
  /** Uniform base size in world units (edge of the projection cube). */
  decalSize: number;
  /** Multiplier on the projection box's X axis (camera-aligned width). */
  decalStretchX: number;
  /** Multiplier on the projection box's Y axis (camera-aligned height). */
  decalStretchY: number;
  /** Ring buffer of prior placements, oldest-first. Capped at 10 entries. */
  decalHistory: PlacementSnapshot[];

  // --- Physical size (drives keychain dimensions and export scale) ---
  /** Target real-world size of the model along `physicalSizeAxis`, in millimetres. */
  physicalSizeMM: number;
  /** Which world axis the physical size is measured along. */
  physicalSizeAxis: SizeAxis;

  // --- Cut (optional, removes everything below cutWorldY on export) ---
  cutEnabled: boolean;
  /** World-space Y coordinate of the cut plane. */
  cutWorldY: number;

  // --- Keychain ring (optional half-torus, dims fixed in mm) ---
  keychainEnabled: boolean;
  /** World-space position of the keychain ring's centre (= midpoint of its flat edge). */
  keychainPosWorld: THREE.Vector3;
}

export function createInitialState(): AppState {
  return {
    model: null,
    modelFilename: null,
    modelBBox: null,
    originalImageFile: null,
    decalTexture: null,
    decalMesh: null,
    decalPlacement: null,
    decalSize: 0.15,
    decalStretchX: 1.0,
    decalStretchY: 1.0,
    decalHistory: [],
    physicalSizeMM: 60,
    physicalSizeAxis: 'y',
    cutEnabled: false,
    cutWorldY: 0,
    keychainEnabled: false,
    keychainPosWorld: new THREE.Vector3(),
  };
}
