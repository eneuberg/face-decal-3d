# face-decal-3d

A small browser tool to project a 2D face photo onto a 3D head model as a surface-conforming decal, then export the result as a GLB.

Built with **Vite + TypeScript (strict)** and **Three.js** (`DecalGeometry`, `GLTFLoader`, `GLTFExporter`). Single-page, no backend.

## What it does

1. Load a `.glb` / `.gltf` head scan
2. Upload a face photo (`.png` / `.jpg` / `.webp`) and crop it — **rectangle** (drag corners) or **lasso** (drag a freehand outline; pixels outside become transparent)
3. Click on the model — the cropped image is projected onto the surface from the current camera angle as a `DecalGeometry` mesh
4. Adjust the size with the slider or **Shift + scroll** for live re-projection (Photoshop-brush style); two extra **Stretch X / Stretch Y** sliders scale the decal independently along the camera-aligned axes
5. Save the combined model + decal as a single binary GLB

## Quick start

```bash
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`).

### Other scripts

| Script              | What it does                                |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | Start the Vite dev server                   |
| `npm run check`     | Type-check with `tsc --noEmit` (strict)     |
| `npm run build`     | Production build (`tsc -b && vite build`)   |
| `npm run preview`   | Preview the production build locally        |

## Usage notes

- **Front-facing assumption.** The decal is projected from the camera's current forward vector. The model's load-time orientation is treated as front-facing, so for best results have the face pointed roughly at the camera before you click.
- **Re-projecting.** If a placement looks bad (smeared across a side surface, partially missing), orbit to a better angle and click again — or hit **Redo Projection** to clear and re-pick.
- **Sizing.** The size value is the edge length of the cube-shaped projection volume in the model's world units. The default `0.15` works well for head models that are roughly a unit tall. Hold **Shift** and scroll over the viewport for live resize.
- **Camera.** Plain mouse wheel zooms (OrbitControls). Drag to orbit, right-drag to pan.

## Architecture

```
src/
  main.ts        DOM event wiring + AppState orchestration
  scene.ts       Three.js scene, camera, OrbitControls, GLTF loading, camera fit
  cropper.ts     Modal crop overlay — rectangle (corner-handle resize) and lasso (freehand polygon clipped to alpha)
  decal.ts       placeDecalAtPointer / resizeDecal / clearDecal — caches the placement so resize doesn't re-raycast
  exporter.ts    Wraps GLTFExporter; reparents model + decal under a temp group for clean export
  ui.ts          DOM helpers (status messages, step highlight, required-element lookup)
  types.ts       AppState, LoadedModel, DecalPlacement
  style.css      Dark studio aesthetic, JetBrains Mono
```

State lives on a single `AppState` object owned by `main.ts`. All consumers are forced through nullable checks (`model: LoadedModel | null`, `decalTexture: THREE.CanvasTexture | null`, …) so missing preconditions surface at compile time instead of as silent no-ops at runtime.

## Future ideas

Planned (not yet implemented):

- **Re-crop in place mode.** Once a decal is placed, allow re-opening the crop modal on the *original* uploaded image to iterate on the crop without re-uploading. Requires keeping the source image around (currently we only keep the cropped canvas / texture).
- **Brightness & saturation sliders.** Color-correct the decal image after cropping. Either CSS-style filter on a working canvas or pixel-wise transform; result is rebaked into the `CanvasTexture` so the live decal updates.
- **Magic skin selection.** A one-click selection that captures skin *and everything inside the skin region* (eyes, mouth, teeth, etc.) — i.e. the head/face mask, with hair and clothing acting as the outer separator. Likely a face-segmentation model (MediaPipe / BodyPix style) producing an alpha mask the texture is multiplied by.
- **Refine selection with lasso / rectangle + hotkeys.** Photoshop-style modifier keys: **Shift** to add to the active selection, **Alt** to subtract. Works with both shape tools on top of whatever the magic-select returned.
- **Ctrl + wheel zoom in the crop modal.** Zoom into the image inside the crop overlay for fine-detail crops. Pan with drag while zoomed.
- **Flat sticker mode (no surface conform).** A checkbox to opt out of `DecalGeometry` projection: instead, place a flat textured plane on the model surface, anchored at the raycast hit point and oriented to face the camera. Useful when the surface is too irregular for the projection to look clean.

Smaller cleanups (also `TODO`s in `src/decal.ts`):

- Multiple decals at once with selection / deletion
- Bake the decal into the base UV texture and export as a single-material mesh
- Rotation handle to spin the decal around the surface normal

## License

MIT
