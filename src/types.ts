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
  decalSize: number;
}

export function createInitialState(): AppState {
  return {
    model: null,
    decalTexture: null,
    decalMesh: null,
    decalPlacement: null,
    decalSize: 0.15,
  };
}
