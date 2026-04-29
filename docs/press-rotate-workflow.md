# Press-and-rotate decal placement workflow

Implementation sketch for the gesture-driven placement model proposed in the README's *Future ideas* section.

## Goal

Replace single-click placement with a continuous press / drag / release gesture so the user can orient the decal *in place* before committing — without losing the current "Ctrl+click to re-project from camera" escape hatch.

## Gesture spec

| Phase | Input | Effect |
| ----- | ----- | ------ |
| Spawn | `Ctrl` + mouse-down on model | Raycast hit → spawn decal facing camera at hit point. Stash hit point + initial normal as the decal's local frame origin. |
| Rotate (default) | Drag while button held, no `R` | Horizontal drag → rotate around the **local Y** axis (surface-normal-aligned). Vertical drag → rotate around the **local Z** axis (forward/back tilt in the decal's own frame). |
| Rotate (R-mode) | Hold `R` + drag | Drag (either axis) → rotate around the **local X** axis (in-plane 2D rotation around the projection normal). Releasing `R` mid-gesture flips back to default mode without ending the gesture. |
| Commit | Mouse-up | Freeze orientation. Decal stays put. Save snapshot for `Ctrl+Z`. |
| Re-rotate | Plain mouse-down (no `Ctrl`) on existing decal | Re-enter rotation gesture against the existing decal. Same axis mapping, same `R` toggle. Reference frame is the decal's *current* orientation, not the original camera frame. |
| Re-project | `Ctrl` + mouse-down on model | Discard current placement, spawn fresh decal at new hit point facing camera (same as Phase 1). |

Drag-to-rotate sensitivity: scale by `pixels-per-radian` constant (~200 px/rad is a reasonable default — same as Blender). Tune later.

## State machine

```
       Ctrl+down on model           up
IDLE ─────────────────────────► PLACING ─────────► IDLE
  ▲                              │   ▲ R toggles axis-mode internally
  │                              │   │
  │ down on existing decal       │   │
  └──────────────────────────────┘   │
                                     │ up
                              ROTATING ◄───── down on existing decal (no Ctrl)
```

`PLACING` and `ROTATING` share the same drag-handler — the only difference is whether they *spawned* a new decal or are operating on the existing one. Implement as a single `ActiveGesture` object with a `kind: 'place' | 'rotate'` discriminator.

## Reference frame math

The rotation must happen in the decal's own frame, not world space, otherwise re-rotating a tilted decal feels sideways.

- Store the decal's orientation as a `THREE.Quaternion` (`decal.quaternion`).
- Each frame of the gesture, build a delta quaternion from the mouse delta and the *currently active local axis* (Y, Z, or X depending on R-state), then post-multiply: `decal.quaternion.multiply(delta)`.
- Local axis is derived by rotating the canonical axis (e.g. `(0,1,0)` for Y) through the current quaternion before building the delta — or, equivalently, build the delta as a local-frame quaternion and post-multiply (Three.js convention).

`DecalGeometry` is regenerated, not rotated, when the orientation changes — the projector's matrix is `position + quaternion + size` and the geometry rebakes each time. Cheap enough at interactive rates for typical decal sizes; profile on a heavy mesh before optimizing.

## Hooks into existing code

- `src/decal.ts` already caches `DecalPlacement` (hit point + size). Extend it with `quaternion: THREE.Quaternion` and a `rotateDecal(delta, axis)` function alongside the existing `resizeDecal`.
- `src/main.ts` owns the pointerdown/move/up wiring — the gesture state machine lives here, next to the existing Shift+scroll resize handler.
- OrbitControls must be **disabled** for the duration of `PLACING` / `ROTATING` (they swallow drags otherwise). Toggle `controls.enabled` on gesture entry/exit.
- `Ctrl+Z` undo: maintain a small ring buffer of `{position, quaternion, size}` snapshots, pushed on commit. Undo restores the previous snapshot and rebuilds the decal geometry.

## Open questions

- **Flat-sticker mode interaction.** When flat-sticker mode lands, the rotation gesture should drive a `THREE.Mesh` quaternion directly (no geometry rebake) — same gesture, simpler implementation. Keep the gesture handler agnostic of which renderer (`DecalGeometry` vs flat plane) it's driving.
- **R held at gesture start.** Should starting a gesture with R already held mean "begin in X-axis mode" or "ignore R until a fresh keypress"? Default to the former — it's less surprising.
- **Touch / pen.** Out of scope for the first pass. Pointer events already cover it API-wise; physical ergonomics (no Ctrl on a tablet) need a separate UI affordance.

## Effort estimate

Roughly half a day for a working first pass, assuming `DecalGeometry` regeneration stays fast enough and OrbitControls toggling is the only real interaction-layer surprise. Most of the work is the state machine + axis math; the rendering side is already in place.
