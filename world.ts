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
  scene: THREE.Scene | null = null;
  
  moveForward = false;
  moveBackward = false;
  moveLeft = false;
  moveRight = false;
  verticalVelocity = 0;
  
  moveSpeed = 50.0;
  jumpVelocity = 50.0;
  gravityForce = 20.0;

  constructor(camera: THREE.Camera, physics: PhysicsWorld, domElement: HTMLElement) {
    this.camera = camera;
    this.physics = physics;
    this.domElement = domElement;
    this.isLocked = false;

    const position = new RAPIER.Vector3(0, 5, 10);
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(position.x, position.y, position.z);

    this.rigidBody = physics.world.createRigidBody(bodyDesc);
    
    const colliderDesc = RAPIER.ColliderDesc.capsule(0.9, 0.3);
    this.collider = physics.world.createCollider(colliderDesc, this.rigidBody);

    this.characterController = physics.world.createCharacterController(0.01);
    this.characterController.enableAutostep(0.5, 0.3, true);
    this.characterController.enableSnapToGround(0.3);

    this.pitchObject = new THREE.Object3D();
    this.pitchObject.add(camera);

    this.yawObject = new THREE.Object3D();
    this.yawObject.position.set(position.x, position.y, position.z);
    this.yawObject.add(this.pitchObject);

    this.object = this.yawObject;
    this.position = this.yawObject.position;

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

    const direction = new THREE.Vector3();
    if (this.moveForward) direction.z = -1;
    if (this.moveBackward) direction.z = 1;
    if (this.moveLeft) direction.x = -1;
    if (this.moveRight) direction.x = 1;
    
    if (direction.lengthSq() > 0) {
      direction.normalize();
      direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yawObject.rotation.y);
    }

    if (!this.characterController.computedGrounded()) {
      this.verticalVelocity -= this.gravityForce * deltaTime;
    } else if (this.verticalVelocity < 0) {
      this.verticalVelocity = 0;
    }

    const movementVector = {
      x: direction.x * this.moveSpeed * deltaTime,
      y: this.verticalVelocity * deltaTime,
      z: direction.z * this.moveSpeed * deltaTime
    };
    
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