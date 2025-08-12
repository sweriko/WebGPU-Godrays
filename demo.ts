import * as THREE from 'three/webgpu';
import { GUI } from 'lil-gui';
import Stats from 'stats.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FPSController, createGround, setupLights } from './world.js';
import { 
  setupVolumetricLighting, 
  animateVolumetricLights,
  VolumetricLightingSystem 
} from './volumetric-lighting.js';
import RAPIER from '@dimforge/rapier3d-compat';

// Initialize scene, camera, and renderer
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

// Physics and control state
let physics: { world: RAPIER.World; rigidBodies: Map<THREE.Object3D, RAPIER.RigidBody> };
let fpsController: FPSController;
let lastTime = 0;

let cathedralModel: THREE.Object3D | null = null;
let groundMesh: THREE.Mesh | null = null;
let customSceneGroup: THREE.Object3D | null = null;
let lights: { ambientLight: THREE.AmbientLight; directionalLight: THREE.DirectionalLight } | null = null;

// Volumetric lighting system
let volumetricSystem: VolumetricLightingSystem | null = null;

// Cathedral configuration for godrays scene
const cathedralConfig = {
  scale: 5.0,
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  castShadow: true,
  receiveShadow: true
};

// Stats.js for performance monitoring
const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb
stats.dom.id = 'stats';
document.body.appendChild(stats.dom);

// Configuration
const config = {
  terrainSize: 200,
  cameraStartPos: { x: -12.48, y: 1.32, z: -34.67 },
  moveSpeed: 20,
  jumpVelocity: 20
};

async function init() {
  console.log('Initializing Cathedral Godray Demo...');
  
  // Initialize WebGPU renderer
  await renderer.init();
  console.log('WebGPU renderer initialized');
  
  await RAPIER.init();
  
  physics = {
    world: new RAPIER.World({ x: 0, y: -9.81, z: 0 }),
    rigidBodies: new Map()
  };

  // Create ground and basic lighting
  groundMesh = createGround(physics, config.terrainSize);
  scene.add(groundMesh);
  lights = setupLights(scene) as any;

  // Setup FPS controller
  fpsController = new FPSController(camera, physics, renderer.domElement);
  fpsController.position.set(config.cameraStartPos.x, config.cameraStartPos.y, config.cameraStartPos.z);
  fpsController.rigidBody.setNextKinematicTranslation({
    x: config.cameraStartPos.x,
    y: config.cameraStartPos.y,
    z: config.cameraStartPos.z
  });
  fpsController.moveSpeed = config.moveSpeed;
  fpsController.jumpVelocity = config.jumpVelocity;
  fpsController.gravityForce = 30.0; // Increased gravity
  scene.add(fpsController.object);
  fpsController.setScene(scene);

  // Load cathedral model
  const gltfLoader = new GLTFLoader();
  
  try {
    console.log('Loading cathedral model...');
    const cathedralResult = await new Promise<any>((resolve, reject) => 
      gltfLoader.load('../textures/cathedral.glb', resolve, undefined, reject));
    
    cathedralModel = cathedralResult.scene;
    console.log('Cathedral model loaded successfully');
    
    // Setup the cathedral scene
    setupCathedralScene();
    
    // Initialize volumetric lighting system
    console.log('Setting up volumetric lighting system...');
    volumetricSystem = setupVolumetricLighting(scene, camera, renderer, config.terrainSize);
    console.log('Volumetric system created:', !!volumetricSystem);
    
    // Configure volumetric lighting for cathedral godrays
    configureCathedralVolumetricLighting();
    
  } catch (error) {
    console.error('Failed to load cathedral model:', error);
  }
  
  window.addEventListener('resize', onWindowResize);
  setupGUI();
  requestAnimationFrame(animate);
}

function removeCustomSceneGroup() {
  if (!customSceneGroup) return;
  
  // Clean up physics bodies for all meshes in the custom scene group
  customSceneGroup.traverse((obj: any) => {
    const rb = physics.rigidBodies.get(obj as any);
    if (rb) {
      physics.world.removeRigidBody(rb);
      physics.rigidBodies.delete(obj as any);
    }
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) obj.material.dispose?.();
  });
  
  scene.remove(customSceneGroup);
  customSceneGroup = null;
  console.log('Cleaned up custom scene group and physics bodies');
}

function setupCathedralScene() {
  if (!cathedralModel) {
    console.warn('Cathedral model not loaded yet');
    return;
  }
  
  console.log('Setting up cathedral scene...');
  
  // Clean up any existing cathedral
  removeCustomSceneGroup();
  
  // Remove skybox and disable lights for dramatic lighting
  scene.background = null;
  scene.environment = null;
  if (lights) {
    lights.ambientLight.intensity = 0; // No ambient light
    lights.directionalLight.intensity = 0; // Disable directional light
  }

  // Set camera rotation for cathedral view (180° from default)
  fpsController.yawObject.rotation.y = Math.PI; // 180 degrees
  fpsController.pitchObject.rotation.x = 0; // Reset pitch to level
  
  // Create cathedral at origin
  customSceneGroup = new THREE.Group();
  customSceneGroup.name = 'CathedralGroup';
  
  // Clone the cathedral model
  const cathedral = cathedralModel.clone();
  cathedral.position.set(cathedralConfig.positionX, cathedralConfig.positionY, cathedralConfig.positionZ);
  cathedral.scale.setScalar(cathedralConfig.scale);
  
  // Enable shadows and physics collision for all meshes in the cathedral
  cathedral.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = cathedralConfig.castShadow;
      child.receiveShadow = cathedralConfig.receiveShadow;
      
      // Ensure the mesh is visible to the main scene pass for depth buffer generation
      child.layers.disableAll();
      child.layers.enable(0); // Main scene layer
      
      // Ensure material writes to depth buffer
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(mat => {
            mat.depthWrite = true;
            mat.depthTest = true;
          });
        } else {
          child.material.depthWrite = true;
          child.material.depthTest = true;
        }
      }
      
      // Add physics collision for each mesh
      child.updateMatrixWorld(true); // Ensure world matrix is up to date
      
      // Get the world position, rotation, and scale
      const worldPosition = new THREE.Vector3();
      const worldQuaternion = new THREE.Quaternion();
      const worldScale = new THREE.Vector3();
      child.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
      
      // Apply cathedral transform
      worldPosition.add(new THREE.Vector3(cathedralConfig.positionX, cathedralConfig.positionY, cathedralConfig.positionZ));
      worldScale.multiplyScalar(cathedralConfig.scale);
      
      // Create physics rigid body for this mesh
      const bodyDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(worldPosition.x, worldPosition.y, worldPosition.z)
        .setRotation(worldQuaternion);
      
      const rigidBody = physics.world.createRigidBody(bodyDesc);
      
      // Create collider based on the mesh geometry
      // For complex cathedral geometry, we'll use a trimesh collider
      if (child.geometry && child.geometry.attributes.position) {
        const vertices = child.geometry.attributes.position.array;
        const indices = child.geometry.index ? child.geometry.index.array : null;
        
        // Scale vertices by the world scale
        const scaledVertices = new Float32Array(vertices.length);
        for (let i = 0; i < vertices.length; i += 3) {
          scaledVertices[i] = vertices[i] * worldScale.x;
          scaledVertices[i + 1] = vertices[i + 1] * worldScale.y;
          scaledVertices[i + 2] = vertices[i + 2] * worldScale.z;
        }
        
        try {
          let colliderDesc;
          if (indices) {
            // Use trimesh for complex geometry with indices
            colliderDesc = RAPIER.ColliderDesc.trimesh(scaledVertices, new Uint32Array(indices));
          } else {
            // For geometry without indices, create indices
            const generatedIndices = new Uint32Array(scaledVertices.length / 3);
            for (let i = 0; i < generatedIndices.length; i++) {
              generatedIndices[i] = i;
            }
            colliderDesc = RAPIER.ColliderDesc.trimesh(scaledVertices, generatedIndices);
          }
          
          physics.world.createCollider(colliderDesc, rigidBody);
          physics.rigidBodies.set(child, rigidBody);
          
          console.log(`Added physics collision for cathedral mesh: ${child.name || 'unnamed'}`);
        } catch (error) {
          console.warn(`Failed to create trimesh collider for ${child.name || 'unnamed'}:`, error);
          
          // Fallback: create a simple box collider based on bounding box
          child.geometry.computeBoundingBox();
          if (child.geometry.boundingBox) {
            const box = child.geometry.boundingBox;
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            
            // Apply scale to size and center
            size.multiply(worldScale);
            center.multiply(worldScale);
            
            // Adjust rigid body position to include the center offset
            const adjustedPosition = {
              x: worldPosition.x + center.x,
              y: worldPosition.y + center.y,
              z: worldPosition.z + center.z
            };
            
            // Remove the old rigid body and create a new one with correct position
            physics.world.removeRigidBody(rigidBody);
            
            const adjustedBodyDesc = RAPIER.RigidBodyDesc.fixed()
              .setTranslation(adjustedPosition.x, adjustedPosition.y, adjustedPosition.z)
              .setRotation(worldQuaternion);
            
            const adjustedRigidBody = physics.world.createRigidBody(adjustedBodyDesc);
            
            const boxColliderDesc = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2);
            physics.world.createCollider(boxColliderDesc, adjustedRigidBody);
            physics.rigidBodies.set(child, adjustedRigidBody);
            
            console.log(`Added fallback box collider for cathedral mesh: ${child.name || 'unnamed'}`);
          }
        }
      }
    }
  });
  
  customSceneGroup.add(cathedral);
  scene.add(customSceneGroup);
  
  console.log('Cathedral placed at origin with scale:', cathedralConfig.scale);
}

function configureCathedralVolumetricLighting() {
  if (!volumetricSystem || !volumetricSystem.volumeControl) return;
  
  console.log('Configuring volumetric lighting for cathedral godrays...');
  
  // Large volume to encompass the cathedral
  volumetricSystem.volumeControl.width = config.terrainSize * 0.6;
  volumetricSystem.volumeControl.height = 40; // Tall enough for cathedral
  volumetricSystem.volumeControl.depth = config.terrainSize * 0.6;
  volumetricSystem.volumeControl.positionY = 20; // Elevated for cathedral height
  volumetricSystem.volumeControl.updateVolume();
  
  // Configure lights for dramatic cathedral godrays
  if (volumetricSystem.pointLight) {
    volumetricSystem.pointLight.intensity = 0; // Disable point light
    volumetricSystem.pointLight.visible = false;
  }
  if (volumetricSystem.spotLight) {
    volumetricSystem.spotLight.intensity = 280; // Optimized intensity
    volumetricSystem.spotLight.position.set(59.5, 150, 100); // Perfect angle for window godrays
    volumetricSystem.spotLight.angle = 0.1; // Very focused beam
    volumetricSystem.spotLight.penumbra = 1; // Full soft edge
    volumetricSystem.spotLight.color.setHex(0xffeac7); // Warm golden color
    volumetricSystem.spotLight.target.position.set(0, 5, 0); // Target cathedral interior
    volumetricSystem.spotLight.visible = true;
    
    // Configure shadow camera for cathedral shadows
    volumetricSystem.spotLight.shadow.camera.far = 200;
    volumetricSystem.spotLight.shadow.camera.near = 1;
    volumetricSystem.spotLight.shadow.mapSize.width = 4096; // High resolution for detailed shadows
    volumetricSystem.spotLight.shadow.mapSize.height = 4096;
    volumetricSystem.spotLight.shadow.camera.updateProjectionMatrix();
  }
  
  // Configure fog for dramatic effect
  if (volumetricSystem.uniforms) {
    volumetricSystem.uniforms.smokeAmount.value = 0; // No smoke for clear godrays
    volumetricSystem.uniforms.volumetricLightingIntensity.value = 2; // Perfect intensity
  }
  
  // Ensure volumetric mesh is visible
  if (volumetricSystem.volumetricMesh) {
    volumetricSystem.volumetricMesh.visible = true;
    console.log('Cathedral godrays configured:', {
      volumeHeight: volumetricSystem.volumeControl?.height,
      spotLightIntensity: volumetricSystem.spotLight?.intensity,
      smokeAmount: volumetricSystem.uniforms?.smokeAmount?.value,
      volumetricIntensity: volumetricSystem.uniforms?.volumetricLightingIntensity?.value
    });
  }
}

function setupGUI() {
  const gui = new GUI();
  
  // Essential Godray Controls
  if (volumetricSystem && volumetricSystem.uniforms) {
    const godrayFolder = gui.addFolder('Godray Controls');
    
    // Key volumetric settings
    godrayFolder.add(volumetricSystem.uniforms.volumetricLightingIntensity, 'value', 0, 5, 0.1).name('Fog Density');
    godrayFolder.add(volumetricSystem.uniforms.smokeAmount, 'value', 0, 3, 0.1).name('Smoke');
    godrayFolder.add(volumetricSystem.uniforms.denoiseStrength, 'value', 0, 1, 0.1).name('Denoising Strength');
    
    // Spotlight controls
    if (volumetricSystem.spotLight) {
      godrayFolder.add(volumetricSystem.spotLight, 'intensity', 50, 500, 10).name('Light Intensity');
      
      // Color control
      const lightColorControl = {
        color: '#ffeac7', // Current warm golden color
        updateColor: function(value: string) {
          if (volumetricSystem && volumetricSystem.spotLight) {
            volumetricSystem.spotLight.color.setHex(parseInt(value.replace('#', '0x')));
          }
        }
      };
      godrayFolder.addColor(lightColorControl, 'color').name('Light Color').onChange(lightColorControl.updateColor);
      
      godrayFolder.add(volumetricSystem.spotLight.position, 'x', 30, 90, 1).name('Light X Position');
      godrayFolder.add(volumetricSystem.spotLight.position, 'y', 100, 200, 5).name('Light Y Position');
      godrayFolder.add(volumetricSystem.spotLight.position, 'z', 50, 150, 5).name('Light Z Position');
    }
    
    godrayFolder.open();
  }
  
  // Apply initial camera offset (slightly increased)
  fpsController.camera.position.y = 3.0;
  
  // Simple pointer lock setup
  renderer.domElement.addEventListener('click', () => {
    if (!gui.domElement.contains(event?.target as Node)) {
      renderer.domElement.requestPointerLock();
    }
  });
}



function animate(time: number) {
  stats.begin();
  
  const deltaTime = (time - lastTime) / 1000;
  lastTime = time;

  physics.world.step();
  fpsController.update(deltaTime);
  
  // Animate volumetric lights if they exist
  if (volumetricSystem) {
    animateVolumetricLights(volumetricSystem);
  }
  
  // Use post-processing if volumetric system is available, otherwise regular render
  if (volumetricSystem?.postProcessing) {
    volumetricSystem.postProcessing.render();
  } else {
    renderer.render(scene, camera);
  }
  
  stats.end();
  requestAnimationFrame(animate);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

init();
