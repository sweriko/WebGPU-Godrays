import * as THREE from 'three/webgpu';
import { vec3, Fn, time, texture3D, screenUV, uniform, screenCoordinate, pass } from 'three/tsl';
import { bayer16 } from 'three/addons/tsl/math/Bayer.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// ============================================================================
// CONSTANTS & INTERFACES
// ============================================================================

export const LAYER_VOLUMETRIC_LIGHTING = 10;

export interface VolumetricLightingSystem {
  volumetricMesh: THREE.Mesh | null;
  pointLight: THREE.PointLight | null;
  spotLight: THREE.SpotLight | null;
  postProcessing: THREE.PostProcessing | null;
  uniforms: {
    smokeAmount: any;
    volumetricLightingIntensity: any;
    denoiseStrength: any;
    volumetricPass: any;
    blurredVolumetricPass: any;
    scenePass: any;
  } | null;
  animationControl: { 
    enableLightAnimation: boolean;
    manualOverride: boolean;
    manualOverrideTime: number;
    lastManualPositions: {
      spotLight?: THREE.Vector3;
      pointLight?: THREE.Vector3;
    };
  } | null;
  volumeControl: {
    width: number;
    height: number;
    depth: number;
    positionX: number;
    positionY: number;
    positionZ: number;
    updateVolume: () => void;
  } | null;
}

// ============================================================================
// NOISE TEXTURE GENERATION
// ============================================================================

function createTexture3D(): THREE.Data3DTexture {
  let i = 0;
  const size = 128;
  const data = new Uint8Array(size * size * size);
  
  const scale = 10;
  const perlin = new ImprovedNoise();
  const repeatFactor = 5.0;
  
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size) * repeatFactor;
        const ny = (y / size) * repeatFactor;
        const nz = (z / size) * repeatFactor;
        
        const noiseValue = perlin.noise(nx * scale, ny * scale, nz * scale);
        data[i] = 128 + 128 * noiseValue;
        i++;
      }
    }
  }
  
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  
  return texture;
}

// ============================================================================
// VOLUMETRIC LIGHTING SYSTEM
// ============================================================================

export function setupVolumetricLighting(
  scene: THREE.Scene, 
  camera: THREE.Camera, 
  renderer: THREE.WebGPURenderer,
  terrainSize: number = 100
): VolumetricLightingSystem {
  const noiseTexture3D = createTexture3D();
  const smokeAmount = uniform(0);
  
  const volumetricMaterial = new THREE.VolumeNodeMaterial();
  volumetricMaterial.steps = 12;
  volumetricMaterial.offsetNode = bayer16(screenCoordinate);
  volumetricMaterial.scatteringNode = Fn(({ positionRay }: any) => {
    const timeScaled = vec3(time, 0, time.mul(0.3));
    
    const sampleGrain = (scale: number, timeScale = 1) => 
      texture3D(noiseTexture3D, positionRay.add(timeScaled.mul(timeScale)).mul(scale).mod(1), 0).r.add(0.5);
    
    let density = sampleGrain(0.1);
    density = density.mul(sampleGrain(0.05, 1));
    density = density.mul(sampleGrain(0.02, 2));
    
    return smokeAmount.mix(1, density);
  });
  
  const initialWidth = terrainSize * 0.8;
  const initialHeight = Math.min(terrainSize * 0.2, 30);
  const initialDepth = terrainSize * 0.6;
  
  let volumetricGeometry = new THREE.BoxGeometry(initialWidth, initialHeight, initialDepth);
  const volumetricMesh = new THREE.Mesh(volumetricGeometry, volumetricMaterial);
  volumetricMesh.receiveShadow = true;
  volumetricMesh.position.set(0, initialHeight / 2, 0);
  volumetricMesh.layers.disableAll();
  volumetricMesh.layers.enable(LAYER_VOLUMETRIC_LIGHTING);
  scene.add(volumetricMesh);
  
  const pointLight = new THREE.PointLight(0xf9bb50, 0, 100);
  pointLight.castShadow = true;
  pointLight.position.set(-5, 12, -8);
  pointLight.layers.enable(LAYER_VOLUMETRIC_LIGHTING);
  scene.add(pointLight);
  
  const spotLight = new THREE.SpotLight(0xffffff, 0);
  spotLight.position.set(8, 18, -12);
  spotLight.angle = Math.PI / 3;
  spotLight.penumbra = 0.8;
  spotLight.decay = 1.5;
  spotLight.distance = 0;
  spotLight.castShadow = true;
  spotLight.shadow.intensity = 0.95;
  spotLight.shadow.mapSize.setScalar(2048);
  spotLight.shadow.camera.near = 0.5;
  spotLight.shadow.camera.far = 150;
  spotLight.shadow.focus = 1;
  spotLight.shadow.bias = -0.001;
  spotLight.layers.enable(LAYER_VOLUMETRIC_LIGHTING);
  spotLight.target.position.set(0, 0, 0);
  scene.add(spotLight.target);
  scene.add(spotLight);
  
  const postProcessing = new THREE.PostProcessing(renderer);
  const volumetricLightingIntensity = uniform(2);
  
  const volumetricLayer = new THREE.Layers();
  volumetricLayer.disableAll();
  volumetricLayer.enable(LAYER_VOLUMETRIC_LIGHTING);
  
  const scenePass = pass(scene, camera);
  const sceneDepth = scenePass.getTextureNode('depth');
  volumetricMaterial.depthNode = sceneDepth.sample(screenUV);
  
  const volumetricPass = pass(scene, camera, { depthBuffer: false });
  volumetricPass.setLayers(volumetricLayer);
  volumetricPass.setResolution(0.5);
  
  const denoiseStrength = uniform(1);
  const blurredVolumetricPass = gaussianBlur(volumetricPass, denoiseStrength);
  const scenePassColor = scenePass.add(blurredVolumetricPass.mul(volumetricLightingIntensity));
  
  postProcessing.outputNode = scenePassColor;
  
  const uniforms = {
    smokeAmount,
    volumetricLightingIntensity,
    denoiseStrength,
    volumetricPass,
    blurredVolumetricPass,
    scenePass
  };

  const volumeControl = {
    width: initialWidth,
    height: initialHeight,
    depth: initialDepth,
    positionX: 0,
    positionY: initialHeight / 2,
    positionZ: 0,
    updateVolume: () => {
      volumetricGeometry.dispose();
      volumetricGeometry = new THREE.BoxGeometry(volumeControl.width, volumeControl.height, volumeControl.depth);
      volumetricMesh.geometry = volumetricGeometry;
      volumetricMesh.position.set(volumeControl.positionX, volumeControl.positionY, volumeControl.positionZ);
    }
  };

  return {
    volumetricMesh,
    pointLight,
    spotLight,
    postProcessing,
    uniforms,
    animationControl: { 
      enableLightAnimation: false,
      manualOverride: false,
      manualOverrideTime: 0,
      lastManualPositions: {}
    },
    volumeControl
  };
}

export function cleanupVolumetricLighting(system: VolumetricLightingSystem, scene: THREE.Scene): void {
  if (system.volumetricMesh) {
    scene.remove(system.volumetricMesh);
    system.volumetricMesh.geometry.dispose();
    (system.volumetricMesh.material as THREE.Material).dispose();
  }
  
  if (system.pointLight) scene.remove(system.pointLight);
  
  if (system.spotLight) {
    scene.remove(system.spotLight);
    scene.remove(system.spotLight.target);
  }
  
  Object.assign(system, {
    volumetricMesh: null,
    pointLight: null,
    spotLight: null,
    postProcessing: null,
    uniforms: null,
    animationControl: null,
    volumeControl: null
  });
}

export function animateVolumetricLights(system: VolumetricLightingSystem): void {
  const control = system.animationControl;
  if (!control?.enableLightAnimation || !system.pointLight || !system.spotLight) return;
  
  const currentTime = performance.now() * 0.001;
  
  // Check for manual position changes
  if (control.lastManualPositions.spotLight && control.lastManualPositions.pointLight) {
    const spotMoved = !system.spotLight.position.equals(control.lastManualPositions.spotLight);
    const pointMoved = !system.pointLight.position.equals(control.lastManualPositions.pointLight);
    
    if (spotMoved || pointMoved) {
      control.manualOverride = true;
      control.manualOverrideTime = currentTime;
    }
  }
  
  if (control.manualOverride && (currentTime - control.manualOverrideTime) > 5.0) {
    control.manualOverride = false;
  }
  
  if (!control.manualOverride) {
    const scale = 3.0;
    
    system.pointLight.position.x = Math.sin(currentTime * 0.5) * scale - 5;
    system.pointLight.position.y = Math.cos(currentTime * 0.3) * 2 + 12;
    system.pointLight.position.z = Math.cos(currentTime * 0.4) * 2 - 8;
    
    system.spotLight.position.x = Math.cos(currentTime * 0.2) * 4 + 8;
    system.spotLight.position.y = Math.sin(currentTime * 0.15) * 3 + 18;
    system.spotLight.position.z = -12 + Math.sin(currentTime * 0.1) * 2;
    system.spotLight.lookAt(0, 3, 0);
  }
  
  control.lastManualPositions.spotLight = system.spotLight.position.clone();
  control.lastManualPositions.pointLight = system.pointLight.position.clone();
}


