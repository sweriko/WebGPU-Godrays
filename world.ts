import * as THREE from 'three/webgpu';
// @ts-ignore
import RAPIER from '@dimforge/rapier3d-compat';

interface PhysicsWorld {
  world: RAPIER.World;
  rigidBodies: Map<THREE.Object3D, RAPIER.RigidBody>;
}

export function setupLights(scene: THREE.Scene) {
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.0);
  dirLight.position.set(5, 10, 7.5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.setScalar(2048);
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 50;
  dirLight.shadow.camera.left = -25;
  dirLight.shadow.camera.right = 25;
  dirLight.shadow.camera.top = 25;
  dirLight.shadow.camera.bottom = -25;
  dirLight.shadow.bias = -0.0005;
  dirLight.target.position.set(0, 0, 0);
  scene.add(dirLight.target);
  scene.add(dirLight);

  return { ambientLight, directionalLight: dirLight };
}



export function createGround(physics: PhysicsWorld, size: number = 1200) {
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  
  const material = new THREE.MeshStandardMaterial({
    color: 0x1a5f2a,
    roughness: 0.8,
    metalness: 0.2,
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  
  const bodyDesc = RAPIER.RigidBodyDesc.fixed();
  const body = physics.world.createRigidBody(bodyDesc);
  
  const colliderDesc = RAPIER.ColliderDesc.cuboid(size / 2, 0.1, size / 2);
  physics.world.createCollider(colliderDesc, body);
  
  physics.rigidBodies.set(mesh, body);
  return mesh;
}

export class InputHandler {
  public update(): void {
    // Minimal input handler - functionality moved to FPSController
  }
}

export interface FPSControllerOptions {
  moveSpeed?: number;
  sprintSpeed?: number;
  jumpSpeed?: number;
  eyeHeight?: number;
  capsuleRadius?: number;
  capsuleHeight?: number;
  mouseSensitivity?: number;
  rotationSmoothingTime?: number;
  invertY?: boolean;
  flyModeInitially?: boolean;
  getGroundHeight?: (x: number, z: number) => number;
}

export class FPSController {
  private world: RAPIER.World;
  private camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;

  public body!: RAPIER.RigidBody;

  private yaw = 0;
  private pitch = 0;

  public moveSpeed: number;
  public sprintSpeed: number;
  public jumpSpeed: number;
  private eyeHeight: number;
  private readonly radius: number;
  private halfHeight: number;
  private mouseSensitivity: number;
  private rotationSmoothingTime: number;
  private invertY: boolean;
  private readonly getGroundHeight?: (x: number, z: number) => number;

  private groundedRayExtra: number = 0.2;
  private groundedTolerance: number = 0.08;

  private moveForward = false;
  private moveBackward = false;
  private moveLeft = false;
  private moveRight = false;
  private isSprinting = false;
  private jumpQueued = false;
  private pointerLocked = false;

  private isFlyMode = false;
  private flyUp = false;
  private flyDown = false;
  private gravityScale = 1;

  private accumDX = 0;
  private accumDY = 0;
  private emaDX = 0;
  private emaDY = 0;

  private debugMesh?: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshBasicMaterial>;
  // Note: collider reference reserved for future sweeps
  // private collider?: RAPIER.Collider;
  // Jump quality: coyote time and buffered jump
  private coyoteTime = 0.12; // seconds after leaving ground where jump still allowed
  private jumpBufferTime = 0.12; // seconds after pressing jump before landing to still perform jump
  private lastGroundedTime = -Infinity;
  private lastJumpPressTime = -Infinity;
  private restFrames: number = 0;

  constructor(physics: PhysicsWorld, camera: THREE.PerspectiveCamera, domElement: HTMLElement, opts: FPSControllerOptions = {}) {
    this.world = physics.world;
    this.camera = camera;
    this.domElement = domElement;

    this.camera.rotation.order = 'YXZ';

    this.moveSpeed = opts.moveSpeed ?? 8.4;
    this.sprintSpeed = opts.sprintSpeed ?? 24.5;
    this.jumpSpeed = opts.jumpSpeed ?? 19.9;
    this.eyeHeight = opts.eyeHeight ?? 2.6;
    this.radius = opts.capsuleRadius ?? 0.35;
    const totalHeight = opts.capsuleHeight ?? 1.8;
    this.halfHeight = Math.max(0.1, (totalHeight - 2 * this.radius) * 0.5);
    this.mouseSensitivity = opts.mouseSensitivity ?? 0.003;
    this.rotationSmoothingTime = opts.rotationSmoothingTime ?? 0.0;
    this.invertY = opts.invertY ?? false;
    this.getGroundHeight = opts.getGroundHeight;

    this.initPhysicsBody();
    this.initPointerLock();
    this.initKeyboard();

    this.yaw = this.camera.rotation.y;
    this.pitch = this.camera.rotation.x;

    if (opts.flyModeInitially) this.setFlyMode(true);

    this.createDebugMesh();
  }

  public updateBeforePhysics(delta: number): void {
    const speed = this.isSprinting ? this.sprintSpeed : this.moveSpeed;
    const inputX = (this.moveRight ? 1 : 0) - (this.moveLeft ? 1 : 0);
    const inputZ = (this.moveForward ? 1 : 0) - (this.moveBackward ? 1 : 0);

    let vx = 0;
    let vz = 0;
    if (inputX !== 0 || inputZ !== 0) {
      const sinY = Math.sin(this.yaw);
      const cosY = Math.cos(this.yaw);
      const forwardX = -sinY;
      const forwardZ = -cosY;
      const rightX = cosY;
      const rightZ = -sinY;
      const dirX = rightX * inputX + forwardX * inputZ;
      const dirZ = rightZ * inputX + forwardZ * inputZ;
      const len = Math.hypot(dirX, dirZ) || 1.0;
      vx = (dirX / len) * speed;
      vz = (dirZ / len) * speed;
    }

    const currentVel = this.body.linvel();
    let vy = currentVel.y;
    const now = performance.now() * 0.001;
    if (this.isFlyMode) {
      const flyInputY = (this.flyUp ? 1 : 0) - (this.flyDown ? 1 : 0);
      vy = flyInputY * speed;
      this.jumpQueued = false;
    } else {
      // Robust grounded check via downward raycast (ignores self)
      const center = this.body.translation();
      const bottomDistance = this.halfHeight + this.radius;
      // Cast ray from slightly above the capsule bottom to avoid starting inside geometry
      const originY = center.y - bottomDistance + 0.05;
      const ray = new RAPIER.Ray({ x: center.x, y: originY, z: center.z }, { x: 0, y: -1, z: 0 });
      const maxToi = this.groundedRayExtra + 0.15;
      let hit: any = undefined;
      if ((this.world as any).castRayAndGetNormal) {
        hit = (this.world as any).castRayAndGetNormal(ray, maxToi, true, undefined, undefined, (collider: RAPIER.Collider) => collider.parent() !== this.body);
      } else {
        hit = this.world.castRay(ray, maxToi, true, undefined, undefined, (collider: RAPIER.Collider) => collider.parent() !== this.body);
      }
      let grounded = false;
      let groundY: number | undefined = undefined;
      if (hit) {
        const toi = (hit.toi !== undefined) ? hit.toi : hit;
        const normal = hit.normal;
        const closeEnough = toi <= this.groundedTolerance + 0.05;
        const upwardSurface = normal ? normal.y > 0.2 : true;
        grounded = closeEnough && upwardSurface;
        if (grounded) groundY = originY - toi;
      } else if (this.getGroundHeight) {
        // Fallback to provided ground height if ray misses
        const bottomY = center.y - bottomDistance;
        const gh = this.getGroundHeight(center.x, center.z);
        grounded = (bottomY - gh) <= this.groundedTolerance;
        if (grounded) groundY = gh;
      }

      // Track grounded time for coyote jumps
      if (grounded) this.lastGroundedTime = now;

      // Reduce bobbing: lightly snap up to ground and kill tiny downwards velocity
      if (grounded && groundY !== undefined) {
        const desiredY = groundY + bottomDistance + 0.001;
        const delta = desiredY - center.y;
        if (delta > 0 && delta < (this.groundedTolerance + 0.06)) {
          this.body.setTranslation({ x: center.x, y: center.y + delta, z: center.z }, true);
          if (vy < 0) vy = 0;
        }
      }

      // Extra grounded heuristic: if vertical velocity is nearly zero for a few frames, treat as grounded
      const vyAlmostZero = Math.abs(currentVel.y) < 0.05;
      if (vyAlmostZero) this.restFrames = Math.min(6, this.restFrames + 1); else this.restFrames = 0;
      const likelyGrounded = grounded || this.restFrames >= 3;

      // Coyote time + buffered jump
      const canCoyote = (now - this.lastGroundedTime) <= this.coyoteTime;
      const jumpBuffered = (now - this.lastJumpPressTime) <= this.jumpBufferTime;
      if ((this.jumpQueued || jumpBuffered) && (likelyGrounded || canCoyote)) {
        vy = this.jumpSpeed;
        this.jumpQueued = false;
        this.lastJumpPressTime = -Infinity; // consume buffer
      } else {
        this.jumpQueued = false;
      }
    }

    this.body.setLinvel({ x: vx, y: vy, z: vz }, true);

    const dx = this.accumDX; const dy = this.accumDY; this.accumDX = 0; this.accumDY = 0;
    const alpha = this.rotationSmoothingTime > 0 ? 1 - Math.exp(-delta / this.rotationSmoothingTime) : 1;
    if (alpha >= 1) { this.emaDX = dx; this.emaDY = dy; } else { this.emaDX += alpha * (dx - this.emaDX); this.emaDY += alpha * (dy - this.emaDY); }
    this.yaw -= this.emaDX * this.mouseSensitivity;
    this.pitch += (this.invertY ? 1 : -1) * this.emaDY * this.mouseSensitivity;
    const pitchMin = -Math.PI / 2 + 0.0001, pitchMax = Math.PI / 2 - 0.0001;
    this.pitch = Math.max(pitchMin, Math.min(pitchMax, this.pitch));
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2; else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(euler);
  }

  public updateAfterPhysics(): void {
    const t = this.body.translation();
    const newCamY = (t.y - (this.halfHeight + this.radius)) + this.eyeHeight;
    this.camera.position.set(t.x, newCamY, t.z);
    if (this.debugMesh) {
      this.debugMesh.position.set(t.x, t.y, t.z);
      this.debugMesh.rotation.set(0, this.yaw, 0);
    }
  }

  private initPhysicsBody(): void {
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, this.eyeHeight + (this.halfHeight + this.radius), 0)
      .setCanSleep(false)
      .setCcdEnabled(true)
      .lockRotations();
    this.body = this.world.createRigidBody(rbDesc);
    const colDesc = RAPIER.ColliderDesc.capsule(this.halfHeight, this.radius)
      .setFriction(0.0)
      .setRestitution(0.0)
      .setActiveEvents(0);
    this.world.createCollider(colDesc, this.body);
  }

  private initPointerLock(): void {
    const onMouseMove = (event: MouseEvent) => {
      if (!this.pointerLocked) return;
      const movementX = event.movementX || 0;
      const movementY = event.movementY || 0;
      const MAX_DELTA = 2000;
      this.accumDX += Math.max(-MAX_DELTA, Math.min(MAX_DELTA, movementX));
      this.accumDY += Math.max(-MAX_DELTA, Math.min(MAX_DELTA, movementY));
    };
    const onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;
      if (this.pointerLocked) document.addEventListener('mousemove', onMouseMove, false);
      else document.removeEventListener('mousemove', onMouseMove, false);
    };
    this.domElement.addEventListener('click', () => { this.domElement.requestPointerLock(); });
    document.addEventListener('pointerlockchange', onPointerLockChange, false);
  }

  private initKeyboard(): void {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyW': this.moveForward = true; break;
        case 'KeyS': this.moveBackward = true; break;
        case 'KeyA': this.moveLeft = true; break;
        case 'KeyD': this.moveRight = true; break;
        case 'ShiftLeft':
        case 'ShiftRight':
          if (this.isFlyMode) { this.flyDown = true; } else { this.isSprinting = true; }
          break;
        case 'ControlLeft':
        case 'ControlRight':
          if (!this.isFlyMode) { this.isSprinting = true; }
          break;
        case 'Space':
          if (this.isFlyMode) { this.flyUp = true; }
          else { this.jumpQueued = true; this.lastJumpPressTime = performance.now() * 0.001; }
          event.preventDefault();
          break;
        case 'KeyF': this.setFlyMode(!this.isFlyMode); break;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyW': this.moveForward = false; break;
        case 'KeyS': this.moveBackward = false; break;
        case 'KeyA': this.moveLeft = false; break;
        case 'KeyD': this.moveRight = false; break;
        case 'ShiftLeft':
        case 'ShiftRight':
          if (this.isFlyMode) { this.flyDown = false; } else { this.isSprinting = false; }
          break;
        case 'ControlLeft':
        case 'ControlRight':
          if (!this.isFlyMode) { this.isSprinting = false; }
          break;
        case 'Space':
          if (this.isFlyMode) { this.flyUp = false; }
          break;
      }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true } as any);
    document.addEventListener('keyup', onKeyUp, { capture: true } as any);
  }

  public setFlyMode(enabled: boolean): void {
    if (this.isFlyMode === enabled) return;
    this.isFlyMode = enabled;
    this.body.setGravityScale(enabled ? 0 : this.gravityScale, true);
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
    this.jumpQueued = false;
    this.flyUp = false;
    this.flyDown = false;
  }

  public enableDebugMesh(scene: THREE.Scene, visible: boolean = true): void {
    if (!this.debugMesh) this.createDebugMesh();
    if (!this.debugMesh) return;
    if (!this.debugMesh.parent) scene.add(this.debugMesh);
    this.debugMesh.visible = visible;
  }

  private createDebugMesh(): void {
    const cylLength = Math.max(0.001, this.halfHeight * 2);
    const radius = this.radius;
    const geo = new THREE.CapsuleGeometry(radius, cylLength, 8, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true, depthTest: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 9999;
    this.debugMesh = mesh;
  }

  // Exposed controls for GUI
  public setMoveSpeed(value: number): void { this.moveSpeed = Math.max(0, value); }
  public setSprintSpeed(value: number): void { this.sprintSpeed = Math.max(0, value); }
  public setJumpSpeed(value: number): void { this.jumpSpeed = Math.max(0, value); }
  public setEyeHeight(value: number): void { this.eyeHeight = Math.max(0, value); }
  public setMouseSensitivity(value: number): void { this.mouseSensitivity = Math.max(0, value); }
  public setRotationSmoothingTime(value: number): void { this.rotationSmoothingTime = Math.max(0, value); }
  public setInvertY(enabled: boolean): void { this.invertY = !!enabled; }
  public isFlyModeEnabled(): boolean { return this.isFlyMode; }
  public getMouseSensitivity(): number { return this.mouseSensitivity; }
  public getRotationSmoothingTime(): number { return this.rotationSmoothingTime; }
  public getEyeHeight(): number { return this.eyeHeight; }
  public getGroundRayExtraDistance(): number { return this.groundedRayExtra; }
  public setGroundRayExtraDistance(value: number): void { this.groundedRayExtra = Math.max(0, value); }
  public getGroundedTolerance(): number { return this.groundedTolerance; }
  public setGroundedTolerance(value: number): void { this.groundedTolerance = Math.max(0, value); }
  public setBodyGravityScale(value: number): void {
    this.gravityScale = Math.max(0, value);
    if (!this.isFlyMode) this.body.setGravityScale(this.gravityScale, true);
  }
}


