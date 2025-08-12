import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

interface PhysicsWorld {
  world: RAPIER.World;
  rigidBodies: Map<THREE.Object3D, RAPIER.RigidBody>;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

// Setup scene lighting
export function setupLights(scene: THREE.Scene) {
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.0);
  dirLight.position.set(5, 10, 7.5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 50;
  dirLight.shadow.camera.left = -25;
  dirLight.shadow.camera.right = 25;
  dirLight.shadow.camera.top = 25;
  dirLight.shadow.camera.bottom = -25;
  dirLight.shadow.bias = -0.0005;
  // Ensure the light targets the world origin (center of ground mesh)
  dirLight.target.position.set(0, 0, 0);
  scene.add(dirLight.target);
  scene.add(dirLight);

  return { ambientLight, directionalLight: dirLight };
}

// Create a simple wall made of vertical columns with slits between them, centered on ground
export function createSlitWall(
  physics: PhysicsWorld,
  options?: Partial<{ width: number; height: number; thickness: number; columns: number; slitWidth: number; color: number }>
) {
  const width = options?.width ?? 20;
  const height = options?.height ?? 6;
  const thickness = options?.thickness ?? 1;
  const columns = Math.max(2, Math.floor(options?.columns ?? 7));
  const slitWidth = options?.slitWidth ?? 0.8;
  const color = options?.color ?? 0xaaaaaa;

  const totalSlitWidth = slitWidth * (columns - 1);
  const columnWidth = (width - totalSlitWidth) / columns;

  const group = new THREE.Group();
  group.name = 'SlitWallGroup';

  const yCenter = height / 2;
  let xCursor = -width / 2 + columnWidth / 2;

  for (let i = 0; i < columns; i++) {
    const geometry = new THREE.BoxGeometry(columnWidth, height, thickness);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
    const column = new THREE.Mesh(geometry, material);
    column.position.set(xCursor, yCenter, 0);
    column.castShadow = true;
    column.receiveShadow = true;
    group.add(column);

    // Physics: fixed rigid body per column
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(xCursor, yCenter, 0);
    const body = physics.world.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.cuboid(columnWidth / 2, height / 2, thickness / 2);
    physics.world.createCollider(collider, body);
    physics.rigidBodies.set(column, body);

    xCursor += columnWidth + slitWidth;
  }

  return group;
}

// Create ground plane with physics
export function createGround(physics: PhysicsWorld, size: number = 1200) {
  const groundGeometry = new THREE.PlaneGeometry(size, size);
  groundGeometry.rotateX(-Math.PI / 2);
  
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a5f2a,
    roughness: 0.8,
    metalness: 0.2,
  });
  
  const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
  groundMesh.receiveShadow = true;
  
  const groundBodyDesc = RAPIER.RigidBodyDesc.fixed();
  const groundBody = physics.world.createRigidBody(groundBodyDesc);
  
  const groundColliderDesc = RAPIER.ColliderDesc.cuboid(size / 2, 0.1, size / 2);
  physics.world.createCollider(groundColliderDesc, groundBody);
  
  physics.rigidBodies.set(groundMesh, groundBody);
  return groundMesh;
}

// ============================================================================
// INPUT HANDLER
// ============================================================================

export class InputHandler {
  public update(): void {
    // Minimal input handler - functionality moved to FPSController
  }
}

// ============================================================================
// FPS CONTROLLER
// ============================================================================

export class FPSController {
  object: THREE.Object3D;
  camera: THREE.Camera;
  physics: PhysicsWorld;
  rigidBody: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  characterController: RAPIER.KinematicCharacterController;
  domElement: HTMLElement;
  pitchObject: THREE.Object3D;
  yawObject: THREE.Object3D;
  isLocked: boolean;
  position: THREE.Vector3;
  scene: THREE.Scene | null;
  
  // Movement state
  moveForward = false;
  moveBackward = false;
  moveLeft = false;
  moveRight = false;
  verticalVelocity = 0;
  
  // Movement parameters
  moveSpeed = 50.0;
  jumpVelocity = 50.0;
  gravityForce = 20.0;

  constructor(camera: THREE.Camera, physics: PhysicsWorld, domElement: HTMLElement) {
    this.camera = camera;
    this.physics = physics;
    this.domElement = domElement;
    this.isLocked = false;
    this.scene = null;

    // Create kinematic rigid body for player
    const position = new RAPIER.Vector3(0, 5, 10);
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(position.x, position.y, position.z);

    this.rigidBody = physics.world.createRigidBody(bodyDesc);
    
    // Create capsule collider
    const colliderDesc = RAPIER.ColliderDesc.capsule(0.9, 0.3);
    this.collider = physics.world.createCollider(colliderDesc, this.rigidBody);

    // Create character controller
    this.characterController = physics.world.createCharacterController(0.01);
    this.characterController.enableAutostep(0.5, 0.3, true);
    this.characterController.enableSnapToGround(0.3);

    // Create 3D objects for camera control
    this.pitchObject = new THREE.Object3D();
    this.pitchObject.add(camera);

    this.yawObject = new THREE.Object3D();
    this.yawObject.position.set(position.x, position.y, position.z);
    this.yawObject.add(this.pitchObject);

    this.object = this.yawObject;
    this.position = this.yawObject.position;

    // Setup controls
    this.setupPointerLock();
    document.addEventListener('keydown', this.onKeyDown.bind(this));
    document.addEventListener('keyup', this.onKeyUp.bind(this));
  }

  setScene(scene: THREE.Scene) {
    this.scene = scene;
  }

  setupPointerLock() {
    const lockChangeEvent = () => {
      this.isLocked = document.pointerLockElement === this.domElement;
    };

    const moveCallback = (event: MouseEvent) => {
      if (!this.isLocked) return;

      this.yawObject.rotation.y -= event.movementX * 0.002;
      this.pitchObject.rotation.x -= event.movementY * 0.002;
      this.pitchObject.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitchObject.rotation.x));
    };

    document.addEventListener('pointerlockchange', lockChangeEvent);
    document.addEventListener('mousemove', moveCallback);
  }

  onKeyDown(event: KeyboardEvent) {
    switch (event.code) {
      case 'KeyW': case 'ArrowUp': this.moveForward = true; break;
      case 'KeyS': case 'ArrowDown': this.moveBackward = true; break;
      case 'KeyA': case 'ArrowLeft': this.moveLeft = true; break;
      case 'KeyD': case 'ArrowRight': this.moveRight = true; break;
      case 'Space': 
        if (this.characterController.computedGrounded()) {
          this.verticalVelocity = this.jumpVelocity;
        }
        break;
    }
  }

  onKeyUp(event: KeyboardEvent) {
    switch (event.code) {
      case 'KeyW': case 'ArrowUp': this.moveForward = false; break;
      case 'KeyS': case 'ArrowDown': this.moveBackward = false; break;
      case 'KeyA': case 'ArrowLeft': this.moveLeft = false; break;
      case 'KeyD': case 'ArrowRight': this.moveRight = false; break;
    }
  }

  update(deltaTime: number) {
    if (!this.rigidBody || !this.characterController) return;

    // Calculate movement direction
    const direction = new THREE.Vector3();
    if (this.moveForward) direction.z = -1;
    if (this.moveBackward) direction.z = 1;
    if (this.moveLeft) direction.x = -1;
    if (this.moveRight) direction.x = 1;
    
    if (direction.lengthSq() > 0) {
      direction.normalize();
      direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yawObject.rotation.y);
    }

    // Apply gravity
    if (!this.characterController.computedGrounded()) {
      this.verticalVelocity -= this.gravityForce * deltaTime;
    } else if (this.verticalVelocity < 0) {
      this.verticalVelocity = 0;
    }

    // Create movement vector
    const movementVector = {
      x: direction.x * this.moveSpeed * deltaTime,
      y: this.verticalVelocity * deltaTime,
      z: direction.z * this.moveSpeed * deltaTime
    };
    
    // Compute and apply movement
    this.characterController.computeColliderMovement(this.collider, movementVector);
    const correctedMovement = this.characterController.computedMovement();
    
    const currentPos = this.rigidBody.translation();
    const newPos = {
      x: currentPos.x + correctedMovement.x,
      y: currentPos.y + correctedMovement.y,
      z: currentPos.z + correctedMovement.z
    };
    
    this.rigidBody.setNextKinematicTranslation(newPos);
    this.position.set(newPos.x, newPos.y, newPos.z);
  }
}