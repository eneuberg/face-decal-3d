import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LoadedModel } from './types';

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelGroup: THREE.Group;
}

export function createScene(container: HTMLElement): SceneContext {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / Math.max(1, container.clientHeight),
    0.01,
    100,
  );
  camera.position.set(0, 0, 2.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Per-material clipping planes (used by the cut-preview to hide the
  // bottom half of the model while keeping the top crisp).
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.1;
  controls.maxDistance = 20;

  // Lighting — keep simple; the model textures provide most of the look.
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(2, 3, 4);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(-2, 1, -2);
  scene.add(fill);

  // Container for the loaded model (kept separate from lights/helpers).
  const modelGroup = new THREE.Group();
  modelGroup.name = 'modelGroup';
  scene.add(modelGroup);

  // Resize observer to keep aspect/size in sync with the viewport element.
  const resize = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', resize);

  // Render loop.
  const tick = (): void => {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return { renderer, scene, camera, controls, modelGroup };
}

export async function loadModelFromFile(
  file: File,
  ctx: SceneContext,
): Promise<LoadedModel> {
  const url = URL.createObjectURL(file);
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);

    // Clear any previously-loaded model.
    while (ctx.modelGroup.children.length > 0) {
      const child = ctx.modelGroup.children[0];
      if (!child) break;
      ctx.modelGroup.remove(child);
    }

    const root = gltf.scene;
    ctx.modelGroup.add(root);

    const meshes: THREE.Mesh[] = [];
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        meshes.push(obj as THREE.Mesh);
      }
    });

    fitCameraToObject(ctx.camera, ctx.controls, root);

    return { root, meshes };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = (camera.fov * Math.PI) / 180;
  // Distance such that the model occupies ~70% of the vertical viewport.
  const distance = (maxDim / Math.tan(fov / 2)) * 0.75;

  camera.position.set(center.x, center.y, center.z + distance);
  camera.near = Math.max(0.001, distance / 100);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}
