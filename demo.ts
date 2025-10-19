import * as THREE from 'three/webgpu';
import { GUI } from 'lil-gui';
import Stats from 'stats.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FPSController, createGround, setupLights } from './world.js';
import { setupVolumetricLighting, animateVolumetricLights, VolumetricLightingSystem } from './volumetric-lighting.js';
import { PixelArtRenderer } from './pixel-art.js';
// @ts-ignore
import RAPIER from '@dimforge/rapier3d-compat';

// Core configuration
const CONFIG = {
  terrainSize: 200,
  cameraStart: { x: -12.48, y: 1.32, z: -34.67 },
  moveSpeed: 20,
  jumpVelocity: 20,
  cathedral: {
    scale: 5.0,
    modelPath: '/cathedral.glb'
  },
  lighting: {
    spotIntensity: 280,
    spotPosition: { x: 59.5, y: 150, z: 100 },
    spotAngle: 0.1,
    spotColor: 0xffeac7,
    volumeHeight: 40
  }
};

// Initialize Three.js
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGPURenderer({ 
  antialias: true,
  requiredLimits: {
    maxStorageBufferBindingSize: 2147483644,
    maxBufferSize: 2147483644
  }
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 2;
document.body.appendChild(renderer.domElement);

// Performance monitoring - show all three panels
const stats = new Stats();
const stats1 = new Stats();
const stats2 = new Stats();

stats.showPanel(0); // FPS
stats1.showPanel(1); // MS
stats2.showPanel(2); // MB

stats.dom.style.cssText = 'position:fixed;top:0;left:0;cursor:pointer;opacity:0.9;z-index:10000';
stats1.dom.style.cssText = 'position:fixed;top:0;left:80px;cursor:pointer;opacity:0.9;z-index:10000';
stats2.dom.style.cssText = 'position:fixed;top:0;left:160px;cursor:pointer;opacity:0.9;z-index:10000';

document.body.appendChild(stats.dom);
document.body.appendChild(stats1.dom);
document.body.appendChild(stats2.dom);

// Global state
let physics: { world: RAPIER.World; rigidBodies: Map<THREE.Object3D, RAPIER.RigidBody> };
let fpsController: FPSController;
let cathedralGroup: THREE.Group | null = null;
let volumetricSystem: VolumetricLightingSystem | null = null;
let lastTime = 0;
let accumulator = 0;
const fixedStep = 1 / 60;
const maxAccum = 0.25;
let pixelArt: PixelArtRenderer | null = null;

async function init() {
  await renderer.init();
  await RAPIER.init();
  
  initPhysics();
  setupScene();
  setupController();
  
  await loadCathedral();
  initVolumetricLighting();
  initPixelArt();
  
  window.addEventListener('resize', onWindowResize);
  setupGUI();
  requestAnimationFrame(animate);
}

function initPhysics() {
  physics = {
    world: new RAPIER.World({ x: 0, y: -33.2, z: 0 }),
    rigidBodies: new Map()
  };
}

function setupScene() {
  const ground = createGround(physics, CONFIG.terrainSize);
  scene.add(ground);
  
  const lights = setupLights(scene);
  lights.ambientLight.intensity = 0;
  lights.directionalLight.intensity = 0;
  
  scene.background = null;
  scene.environment = null;
}

function setupController() {
  // Spawn slightly above origin to ensure inside the cathedral
  const start = { x: 0, y: 8.0, z: 0 };
  fpsController = new FPSController(physics, camera as any, renderer.domElement, {
    moveSpeed: 8.4,
    sprintSpeed: 24.5,
    jumpSpeed: 19.9,
    eyeHeight: 2.6,
    capsuleRadius: 0.35,
    capsuleHeight: 1.8,
    mouseSensitivity: 0.003,
    rotationSmoothingTime: 0.0,
    invertY: false,
    flyModeInitially: false,
    getGroundHeight: () => 0.1
  });
  // Set initial transform
  fpsController.body.setTranslation({ x: start.x, y: start.y, z: start.z }, true);
  camera.position.set(start.x, start.y, start.z);
}

function initPixelArt() {
  pixelArt = new PixelArtRenderer(renderer, camera, {
    virtualHeight: 180,
    anchorDistance: 10,
    enabled: true
  });
}

async function loadCathedral() {
  const loader = new GLTFLoader();
  try {
    const result = await new Promise<any>((resolve, reject) => 
      loader.load(CONFIG.cathedral.modelPath, resolve, undefined, reject));
    setupCathedralScene(result.scene);
  } catch (error) {
    console.error('Failed to load cathedral:', error);
  }
}

function initVolumetricLighting() {
  volumetricSystem = setupVolumetricLighting(scene, camera, renderer, CONFIG.terrainSize);
  if (volumetricSystem) {
    configureCathedralGodrays();
  }
}

function cleanupCathedral() {
  if (!cathedralGroup) return;
  
  cathedralGroup.traverse((obj: any) => {
    const rb = physics.rigidBodies.get(obj);
    if (rb) {
      physics.world.removeRigidBody(rb);
      physics.rigidBodies.delete(obj);
    }
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) obj.material.dispose?.();
  });
  
  scene.remove(cathedralGroup);
  cathedralGroup = null;
}

function setupCathedralScene(model: THREE.Object3D) {
  cleanupCathedral();
  
  cathedralGroup = new THREE.Group();
  cathedralGroup.name = 'Cathedral';
  
  const cathedral = model.clone();
  cathedral.scale.setScalar(CONFIG.cathedral.scale);
  
  // Add cathedral to group and scene first
  cathedralGroup.add(cathedral);
  scene.add(cathedralGroup);
  
  // Force matrix updates for the entire hierarchy
  cathedralGroup.updateMatrixWorld(true);
  
  cathedral.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      child.layers.enable(0);
      
      if (child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(mat => {
          mat.depthWrite = true;
          mat.depthTest = true;
        });
      }
      
      addCathedralPhysics(child);
    }
  });
}

function addCathedralPhysics(mesh: THREE.Mesh) {
  if (!mesh.geometry || !mesh.geometry.attributes.position) return;

  mesh.updateMatrixWorld(true);
  
  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();  
  const worldScale = new THREE.Vector3();
  mesh.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
  
  const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(worldPosition.x, worldPosition.y, worldPosition.z)
    .setRotation(worldQuaternion);
  
  const rigidBody = physics.world.createRigidBody(bodyDesc);
  
  const vertices = mesh.geometry.attributes.position.array;
  const indices = mesh.geometry.index ? mesh.geometry.index.array : null;
  
  const scaledVertices = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    scaledVertices[i] = vertices[i] * worldScale.x;
    scaledVertices[i + 1] = vertices[i + 1] * worldScale.y;
    scaledVertices[i + 2] = vertices[i + 2] * worldScale.z;
  }
  
  try {
    let colliderDesc;
    if (indices) {
      colliderDesc = RAPIER.ColliderDesc.trimesh(scaledVertices, new Uint32Array(indices));
    } else {
      const generatedIndices = new Uint32Array(scaledVertices.length / 3);
      for (let i = 0; i < generatedIndices.length; i++) {
        generatedIndices[i] = i;
      }
      colliderDesc = RAPIER.ColliderDesc.trimesh(scaledVertices, generatedIndices);
    }
    
    physics.world.createCollider(colliderDesc, rigidBody);
    physics.rigidBodies.set(mesh, rigidBody);
    
  } catch {
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    
    size.multiply(worldScale);
    center.multiply(worldScale);
    
    physics.world.removeRigidBody(rigidBody);
    
    const newBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(
        worldPosition.x + center.x, 
        worldPosition.y + center.y, 
        worldPosition.z + center.z
      )
      .setRotation(worldQuaternion);
    
    const newRigidBody = physics.world.createRigidBody(newBodyDesc);
    const boxColliderDesc = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2);
    physics.world.createCollider(boxColliderDesc, newRigidBody);
    physics.rigidBodies.set(mesh, newRigidBody);
  }
}

function configureCathedralGodrays() {
  if (!volumetricSystem) return;
  
  const { volumeControl, pointLight, spotLight, uniforms } = volumetricSystem;
  
  // Configure volume
  if (volumeControl) {
    volumeControl.width = CONFIG.terrainSize * 0.6;
    volumeControl.height = CONFIG.lighting.volumeHeight;
    volumeControl.depth = CONFIG.terrainSize * 0.6;
    volumeControl.positionY = 20;
    volumeControl.updateVolume();
  }
  
  // Configure lights
  if (pointLight) {
    pointLight.intensity = 0;
    pointLight.visible = false;
  }
  
  if (spotLight) {
    const { spotPosition, spotIntensity, spotAngle, spotColor } = CONFIG.lighting;
    spotLight.intensity = spotIntensity;
    spotLight.position.set(spotPosition.x, spotPosition.y, spotPosition.z);
    spotLight.angle = spotAngle;
    spotLight.penumbra = 1;
    spotLight.color.setHex(spotColor);
    spotLight.target.position.set(0, 5, 0);
    spotLight.visible = true;
    
    // Configure shadow camera for cathedral shadows
    spotLight.shadow.camera.far = 200;
    spotLight.shadow.camera.near = 1;
    spotLight.shadow.mapSize.width = 4096;
    spotLight.shadow.mapSize.height = 4096;
    spotLight.shadow.camera.updateProjectionMatrix();
  }
  
  // Configure fog
  if (uniforms) {
    uniforms.smokeAmount.value = 0;
    uniforms.volumetricLightingIntensity.value = 2;
  }
  
  // Ensure volumetric mesh is visible
  if (volumetricSystem.volumetricMesh) {
    volumetricSystem.volumetricMesh.visible = true;
  }
}

function setupGUI() {
  const gui = new GUI();
  
  // Position GUI to the right edge
  gui.domElement.style.position = 'fixed';
  gui.domElement.style.top = '0px';
  gui.domElement.style.right = '0px';
  gui.domElement.style.zIndex = '1000';
  gui.domElement.style.paddingBottom = '25px';
  
  // Controller folder
  if (fpsController) {
    const ctrlParams = {
      moveSpeed: fpsController.moveSpeed,
      sprintSpeed: fpsController.sprintSpeed,
      jumpSpeed: (fpsController as any).setJumpSpeed ? (fpsController as any)['jumpSpeed'] ?? 19.9 : 19.9,
      eyeHeight: (fpsController as any).getEyeHeight ? (fpsController as any).getEyeHeight() : 1.6,
      mouseSensitivity: (fpsController as any).getMouseSensitivity ? (fpsController as any).getMouseSensitivity() : 0.003,
      smoothingTime: (fpsController as any).getRotationSmoothingTime ? (fpsController as any).getRotationSmoothingTime() : 0,
      invertY: false,
      flyMode: (fpsController as any).isFlyModeEnabled ? (fpsController as any).isFlyModeEnabled() : false,
      rayExtra: (fpsController as any).getGroundRayExtraDistance ? (fpsController as any).getGroundRayExtraDistance() : 0.2,
      groundedTolerance: (fpsController as any).getGroundedTolerance ? (fpsController as any).getGroundedTolerance() : 0.08,
      debugCapsule: false,
      toggleFly: () => (fpsController as any).setFlyMode(!(fpsController as any).isFlyModeEnabled?.())
    };
    const fCtrl = gui.addFolder('Controller');
    fCtrl.add(ctrlParams, 'debugCapsule').name('Show Capsule').onChange((v: boolean) => (fpsController as any).enableDebugMesh(scene, v));
    fCtrl.add(ctrlParams, 'moveSpeed', 1, 40, 0.1).onChange((v: number) => (fpsController as any).setMoveSpeed(v));
    fCtrl.add(ctrlParams, 'sprintSpeed', 1, 60, 0.1).onChange((v: number) => (fpsController as any).setSprintSpeed(v));
    fCtrl.add(ctrlParams, 'jumpSpeed', 1, 40, 0.1).onChange((v: number) => (fpsController as any).setJumpSpeed(v));
    fCtrl.add(ctrlParams, 'eyeHeight', 0.4, 2.6, 0.01).onChange((v: number) => (fpsController as any).setEyeHeight(v));
    fCtrl.add(ctrlParams, 'mouseSensitivity', 0.0005, 0.01, 0.0001).onChange((v: number) => (fpsController as any).setMouseSensitivity(v));
    fCtrl.add(ctrlParams, 'smoothingTime', 0, 0.5, 0.005).onChange((v: number) => (fpsController as any).setRotationSmoothingTime(v));
    fCtrl.add(ctrlParams, 'invertY').onChange((v: boolean) => (fpsController as any).setInvertY(v));
    fCtrl.add(ctrlParams, 'rayExtra', 0, 0.6, 0.01).name('Ground Ray Extra').onChange((v: number) => (fpsController as any).setGroundRayExtraDistance(v));
    fCtrl.add(ctrlParams, 'groundedTolerance', 0.01, 0.3, 0.005).name('Ground Tolerance').onChange((v: number) => (fpsController as any).setGroundedTolerance(v));
    fCtrl.add(ctrlParams, 'toggleFly').name('Toggle Fly (F)');
  }

  // Physics folder: gravity controls
  if (physics?.world) {
    const g = physics.world.gravity;
    const grav = { x: g.x, y: g.y, z: g.z, bodyScale: 1 };
    const fPhys = gui.addFolder('Physics');
    fPhys.add(grav, 'y', -50, 0, 0.1).name('Gravity Y').onChange((v: number) => {
      physics.world.gravity = { x: grav.x, y: v, z: grav.z } as any;
    });
    fPhys.add(grav, 'x', -20, 20, 0.1).name('Gravity X').onChange((v: number) => {
      physics.world.gravity = { x: v, y: grav.y, z: grav.z } as any;
    });
    fPhys.add(grav, 'z', -20, 20, 0.1).name('Gravity Z').onChange((v: number) => {
      physics.world.gravity = { x: grav.x, y: grav.y, z: v } as any;
    });
    if (fpsController) {
      fPhys.add(grav, 'bodyScale', 0, 2, 0.01).name('Player Gravity Scale').onChange((v: number) => {
        (fpsController as any).setBodyGravityScale(v);
      });
    }
  }

  if (!volumetricSystem?.uniforms || !volumetricSystem.spotLight) return;
  
  const { uniforms, spotLight } = volumetricSystem;
  const godrayFolder = gui.addFolder('Godray Controls');
  
  godrayFolder.add(uniforms.volumetricLightingIntensity, 'value', 0, 5, 0.1).name('Fog Density');
  godrayFolder.add(uniforms.smokeAmount, 'value', 0, 3, 0.1).name('Smoke');
  godrayFolder.add(uniforms.denoiseStrength, 'value', 0, 1, 0.1).name('Denoising');
  godrayFolder.add(spotLight, 'intensity', 50, 500, 10).name('Light Intensity');
  
  const colorControl = {
    color: '#ffeac7',
    updateColor: (value: string) => {
      spotLight.color.setHex(parseInt(value.replace('#', '0x')));
    }
  };
  godrayFolder.addColor(colorControl, 'color').name('Light Color').onChange(colorControl.updateColor);
  
  godrayFolder.add(spotLight.position, 'x', 30, 90, 1).name('Light X');
  godrayFolder.add(spotLight.position, 'y', 100, 200, 5).name('Light Y');
  godrayFolder.add(spotLight.position, 'z', 50, 150, 5).name('Light Z');
  
  godrayFolder.open();
  
  if (pixelArt) {
    const pixelFolder = gui.addFolder('Pixel Art');
    const pixelSettings = {
      enabled: true,
      virtualHeight: pixelArt['options'].virtualHeight
    };
    pixelFolder.add(pixelSettings, 'enabled').name('Enable').onChange((v: boolean) => {
      pixelArt?.setEnabled(v);
    });
    pixelFolder.add(pixelSettings, 'virtualHeight', 90, 360, 1).name('Virtual Height').onChange((v: number) => {
      if (!pixelArt) return;
      pixelArt['options'].virtualHeight = Math.floor(v);
      pixelArt.updateVirtualResolution();
    });
    pixelFolder.open();
  }

  // Add model source hyperlink to bottom right of GUI
  const linkElement = document.createElement('div');
  linkElement.style.position = 'absolute';
  linkElement.style.bottom = '8px';
  linkElement.style.right = '8px';
  linkElement.style.fontSize = '10px';
  linkElement.innerHTML = '<a href="https://fab.com/s/06173ad52aa7" target="_blank" style="color: #4a9eff; text-decoration: underline;">3D model source</a>';
  gui.domElement.appendChild(linkElement);
  
  // Toggle GUI visibility with 'P' key
  let guiVisible = true;
  document.addEventListener('keydown', (event) => {
    if (event.code === 'KeyP') {
      guiVisible = !guiVisible;
      gui.domElement.style.display = guiVisible ? 'block' : 'none';
    }
  });

  renderer.domElement.addEventListener('click', (ev) => {
    if (!(gui.domElement as HTMLElement).contains(ev.target as Node)) {
      renderer.domElement.requestPointerLock();
    }
  });
}

function animate(time: number) {
  stats.begin();
  stats1.begin();
  stats2.begin();
  
  const deltaTime = (time - lastTime) / 1000;
  lastTime = time;
  accumulator += deltaTime;
  if (accumulator > maxAccum) accumulator = maxAccum;
  while (accumulator >= fixedStep) {
    fpsController.updateBeforePhysics(fixedStep);
    physics.world.step();
    fpsController.updateAfterPhysics();
    accumulator -= fixedStep;
  }
  
  if (pixelArt) pixelArt.preRender();

  if (volumetricSystem) {
    animateVolumetricLights(volumetricSystem);
    volumetricSystem.postProcessing?.render();
  } else {
    renderer.render(scene, camera);
  }
  if (pixelArt) pixelArt.postRender();
  
  stats.end();
  stats1.end();
  stats2.end();
  requestAnimationFrame(animate);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (pixelArt) {
    pixelArt.onResize();
  } else {
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

init();
