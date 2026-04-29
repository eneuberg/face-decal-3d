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

export interface AppState {
  model: LoadedModel | null;
  decalTexture: THREE.CanvasTexture | null;
  decalMesh: THREE.Mesh | null;
  decalPlacement: DecalPlacement | null;
  /** Uniform base size in world units (edge of the projection cube). */
  decalSize: number;
  /** Multiplier on the projection box's X axis (camera-aligned width). */
  decalStretchX: number;
  /** Multiplier on the projection box's Y axis (camera-aligned height). */
  decalStretchY: number;
}

export function createInitialState(): AppState {
  return {
    model: null,
    decalTexture: null,
    decalMesh: null,
    decalPlacement: null,
    decalSize: 0.15,
    decalStretchX: 1.0,
    decalStretchY: 1.0,
  };
}
