import * as THREE from 'three/webgpu';

export interface PixelArtOptions {
  virtualHeight?: number; // target low-res height in pixels (width is derived from aspect)
  anchorDistance?: number; // world units in front of camera to anchor quantization
  enabled?: boolean;
}

export class PixelArtRenderer {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  options: Required<PixelArtOptions>;
  virtualWidth = 320;
  virtualHeight = 180;
  epsilon = new THREE.Vector2();
  _prevEnabled = false;
  _originalDPR = 1;
  _canvas: HTMLCanvasElement;

  constructor(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera, options: PixelArtOptions = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.options = {
      virtualHeight: options.virtualHeight ?? 180,
      anchorDistance: options.anchorDistance ?? 10,
      enabled: options.enabled ?? true
    };
    this._canvas = renderer.domElement as HTMLCanvasElement;

    if (this.options.enabled) this.enable();
    else this.disable();
  }

  setEnabled(enabled: boolean): void {
    if (enabled) this.enable();
    else this.disable();
  }

  enable(): void {
    if (this._prevEnabled) return;
    this._prevEnabled = true;
    this._originalDPR = (window.devicePixelRatio || 1);
    // Force 1x DPR for crisp pixelation
    this.renderer.setPixelRatio(1);
    this._canvas.style.imageRendering = 'pixelated';
    this._canvas.style.transformOrigin = '0 0';
    this._canvas.style.width = '100vw';
    this._canvas.style.height = '100vh';
    this.updateVirtualResolution();
  }

  disable(): void {
    if (!this._prevEnabled) return;
    this._prevEnabled = false;
    this.clearCameraJitter();
    this._canvas.style.imageRendering = '';
    this._canvas.style.transform = '';
    this._canvas.style.transformOrigin = '';
    this._canvas.style.width = '';
    this._canvas.style.height = '';
    this.renderer.setPixelRatio(this._originalDPR);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  updateVirtualResolution(): void {
    const aspect = window.innerWidth / window.innerHeight;
    this.virtualHeight = Math.max(1, Math.floor(this.options.virtualHeight));
    this.virtualWidth = Math.max(1, Math.floor(this.virtualHeight * aspect));
    this.renderer.setSize(this.virtualWidth, this.virtualHeight, false);
  }

  onResize(): void {
    if (!this._prevEnabled) return;
    this.updateVirtualResolution();
  }

  preRender(): void {
    if (!this._prevEnabled) return;
    this.applyCameraJitter();
  }

  postRender(): void {
    if (!this._prevEnabled) return;
    this.clearCameraJitter();
    // Re-introduce the sub-pixel remainder as a presentation-time shift
    const scaleX = window.innerWidth / this.virtualWidth;
    const scaleY = window.innerHeight / this.virtualHeight;
    const shiftX = -this.epsilon.x * scaleX;
    // Screen Y is top-down; NDC Y is bottom-up → invert sign
    const shiftY = this.epsilon.y * scaleY;
    this._canvas.style.transform = `translate(${shiftX}px, ${shiftY}px)`;
  }

  private applyCameraJitter(): void {
    // Compute fractional screen-space position of an anchor forward of the camera
    const cam = this.camera;
    const camWorld = cam.getWorldPosition(new THREE.Vector3());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const anchorWorld = camWorld.add(forward.multiplyScalar(this.options.anchorDistance));
    const ndc = anchorWorld.clone().project(cam);

    const px = (ndc.x * 0.5 + 0.5) * this.virtualWidth;
    const py = (ndc.y * 0.5 + 0.5) * this.virtualHeight;

    const rx = Math.round(px);
    const ry = Math.round(py);
    const fracX = px - rx;
    const fracY = py - ry;
    this.epsilon.set(fracX, fracY);

    // Snap by canceling the fractional part via projection view offset
    cam.setViewOffset(this.virtualWidth, this.virtualHeight, -fracX, -fracY, this.virtualWidth, this.virtualHeight);
  }

  private clearCameraJitter(): void {
    this.camera.clearViewOffset();
  }
}



