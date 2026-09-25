import * as THREE from 'three';

/**
 * Orbit camera around the render origin, which is always the focused object
 * (floating origin). Azimuth and elevation are measured in the plotting
 * frame's axes: elevation from its x-y plane toward +z (three.js +Y).
 */
export class CameraRig {
  azimuth = -Math.PI / 2;
  elevation = 0.45;
  /** Render units (kilometres) from the focus. */
  distance: number;
  minDistance = 0.01;
  readonly maxDistance: number;
  private dragging: { x: number; y: number } | null = null;

  constructor(element: HTMLElement, initialDistance: number, maxDistance: number) {
    this.distance = initialDistance;
    this.maxDistance = maxDistance;
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    element.addEventListener('pointerdown', (e) => {
      element.setPointerCapture(e.pointerId);
      this.dragging = { x: e.clientX, y: e.clientY };
    });
    element.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragging.x;
      const dy = e.clientY - this.dragging.y;
      this.dragging = { x: e.clientX, y: e.clientY };
      this.azimuth -= dx * 0.005;
      this.elevation = Math.max(-1.55, Math.min(1.55, this.elevation + dy * 0.005));
    });
    const end = (e: PointerEvent) => {
      if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
      this.dragging = null;
    };
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    element.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setDistance(this.distance * Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
  }

  setDistance(value: number): void {
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, value));
  }

  apply(camera: THREE.PerspectiveCamera): void {
    const ce = Math.cos(this.elevation);
    // Frame (x, y, z) -> three (x, z, -y).
    const fx = ce * Math.cos(this.azimuth);
    const fy = ce * Math.sin(this.azimuth);
    const fz = Math.sin(this.elevation);
    camera.position.set(fx * this.distance, fz * this.distance, -fy * this.distance);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.near = this.distance * 1e-4;
    camera.far = this.distance * 1e9;
    camera.updateProjectionMatrix();
  }
}
