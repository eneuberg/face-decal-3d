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

export interface AppState {
  model: LoadedModel | null;
  /** Original filename of the loaded model, used to derive the export name. */
  modelFilename: string | null;
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
}

export function createInitialState(): AppState {
  return {
    model: null,
    modelFilename: null,
    originalImageFile: null,
    decalTexture: null,
    decalMesh: null,
    decalPlacement: null,
    decalSize: 0.15,
    decalStretchX: 1.0,
    decalStretchY: 1.0,
    decalHistory: [],
  };
}
