import * as THREE from 'three';
import type { LoadedModel } from './types';

/**
 * Live preview of the bottom-trim cut. The actual geometry trim happens at
 * export time (see csg.ts) — here we just show the user what they'll get:
 *
 *   - a red transparent plane sitting at the chosen world Y
 *   - clipping planes on the model materials so the part above renders solid
 *   - cloned ghost meshes (very low opacity) so the part being removed is
 *     still visible but obviously "going away"
 *
 * Clipping planes are interpreted in world space, so model transforms don't
 * need any special handling. We share the same THREE.Plane instances between
 * the "keep above" and "ghost below" sides so a single setHeight() call
 * keeps both in sync.
 */
export class CutController {
  /** Plane equation: y > worldY is kept (used by the real model materials). */
  private readonly clipKeepAbove: THREE.Plane;
  /** Plane equation: y < worldY is kept (used by the ghost copy of the model). */
  private readonly clipKeepBelow: THREE.Plane;

  private planeMesh: THREE.Mesh | null = null;
  private ghostMeshes: THREE.Mesh[] = [];
  private originalClipState: WeakMap<THREE.Material, THREE.Plane[] | null> = new WeakMap();

  private attachedModel: LoadedModel | null = null;
  private attachedParent: THREE.Object3D | null = null;
  private bbox: THREE.Box3 | null = null;
  private currentY = 0;

  constructor() {
    this.clipKeepAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.clipKeepBelow = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  }

  isAttached(): boolean {
    return this.attachedModel !== null;
  }

  /** Attach to the loaded model. Idempotent — calling twice is a no-op. */
  attach(model: LoadedModel, parent: THREE.Object3D, bbox: THREE.Box3, worldY: number): void {
    if (this.attachedModel) return;
    this.attachedModel = model;
    this.attachedParent = parent;
    this.bbox = bbox;

    // Hook clipping plane onto every UNIQUE material across all meshes.
    // Multiple meshes can share a material reference; we must save state and
    // attach the plane exactly once per material, otherwise the second save
    // captures already-modified state and detach can't restore properly.
    const seenMats = new Set<THREE.Material>();
    for (const mesh of model.meshes) {
      for (const m of materialList(mesh)) {
        if (seenMats.has(m)) continue;
        seenMats.add(m);
        this.originalClipState.set(m, m.clippingPlanes ? m.clippingPlanes.slice() : null);
        m.clippingPlanes = (m.clippingPlanes ?? []).concat(this.clipKeepAbove);
        m.clipShadows = true;
        m.needsUpdate = true;
      }

      // Ghost: clone the mesh (shares geometry), give it a translucent material
      // clipped to only the BELOW side. Sibling so transforms match perfectly.
      const ghostMat = new THREE.MeshBasicMaterial({
        color: 0x803030,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        side: THREE.DoubleSide,
        clippingPlanes: [this.clipKeepBelow],
      });
      const ghost = new THREE.Mesh(mesh.geometry, ghostMat);
      ghost.position.copy(mesh.position);
      ghost.quaternion.copy(mesh.quaternion);
      ghost.scale.copy(mesh.scale);
      ghost.name = `${mesh.name || 'mesh'}_cutGhost`;
      ghost.renderOrder = 1; // draw after solids so transparency blends right
      mesh.parent?.add(ghost);
      this.ghostMeshes.push(ghost);
    }

    this.rebuildPlaneMesh();
    if (this.planeMesh) parent.add(this.planeMesh);

    this.setHeight(worldY);
  }

  detach(): void {
    if (!this.attachedModel || !this.attachedParent) return;

    // Mirror attach(): restore each unique material exactly once.
    const seenMats = new Set<THREE.Material>();
    for (const mesh of this.attachedModel.meshes) {
      for (const m of materialList(mesh)) {
        if (seenMats.has(m)) continue;
        seenMats.add(m);
        const saved = this.originalClipState.get(m);
        m.clippingPlanes = saved === undefined ? null : saved;
        m.needsUpdate = true;
        this.originalClipState.delete(m);
      }
    }

    for (const g of this.ghostMeshes) {
      g.parent?.remove(g);
      (g.material as THREE.Material).dispose();
    }
    this.ghostMeshes = [];

    if (this.planeMesh) {
      this.attachedParent.remove(this.planeMesh);
      this.planeMesh.geometry.dispose();
      (this.planeMesh.material as THREE.Material).dispose();
      this.planeMesh = null;
    }

    this.attachedModel = null;
    this.attachedParent = null;
    this.bbox = null;
  }

  /** Move the cut plane. Updates clipping planes and the visual plane mesh. */
  setHeight(worldY: number): void {
    this.currentY = worldY;
    // Plane equation: dot(normal, p) + constant = 0.
    // Keep-above (normal +Y): kept where y > worldY → constant = -worldY.
    // Keep-below (normal -Y): kept where -y > -worldY → constant = worldY.
    this.clipKeepAbove.constant = -worldY;
    this.clipKeepBelow.constant = worldY;
    if (this.planeMesh) this.planeMesh.position.y = worldY;
  }

  getHeight(): number {
    return this.currentY;
  }

  private rebuildPlaneMesh(): void {
    if (!this.bbox) return;
    if (this.planeMesh) {
      this.planeMesh.geometry.dispose();
      (this.planeMesh.material as THREE.Material).dispose();
    }
    const size = this.bbox.getSize(new THREE.Vector3());
    const center = this.bbox.getCenter(new THREE.Vector3());
    const w = size.x * 1.4;
    const d = size.z * 1.4;
    const geom = new THREE.PlaneGeometry(w, d);
    geom.rotateX(-Math.PI / 2); // make it horizontal (normal +Y)
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3344,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.planeMesh = new THREE.Mesh(geom, mat);
    this.planeMesh.position.set(center.x, this.currentY, center.z);
    this.planeMesh.name = 'cutPlanePreview';
    this.planeMesh.renderOrder = 2;
  }
}

function materialList(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}
