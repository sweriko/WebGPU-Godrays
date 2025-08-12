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
  console.log('Volumetric Setup - Starting setup with terrain size:', terrainSize);
  
  // Create 3D noise texture
  const noiseTexture3D = createTexture3D();
  console.log('Volumetric Setup - 3D noise texture created');
  
  // Smoke amount uniform for controlling density
  const smokeAmount = uniform(0);
  
  // Create volumetric material
  const volumetricMaterial = new THREE.VolumeNodeMaterial();
  volumetricMaterial.steps = 12;
  volumetricMaterial.offsetNode = bayer16(screenCoordinate); // Add dithering to reduce banding
  volumetricMaterial.scatteringNode = Fn(({ positionRay }: any) => {
    // Return the amount of fog based on the noise texture
    const timeScaled = vec3(time, 0, time.mul(0.3));
    
    const sampleGrain = (scale: number, timeScale = 1) => 
      texture3D(noiseTexture3D, positionRay.add(timeScaled.mul(timeScale)).mul(scale).mod(1), 0).r.add(0.5);
    
    let density = sampleGrain(0.1);
    density = density.mul(sampleGrain(0.05, 1));
    density = density.mul(sampleGrain(0.02, 2));
    
    return smokeAmount.mix(1, density);
  });
  
  // Create initial volume dimensions based on terrain size
  const initialWidth = terrainSize * 0.8; // Cover 80% of terrain width
  const initialHeight = Math.min(terrainSize * 0.2, 30); // Height proportional to terrain, max 30
  const initialDepth = terrainSize * 0.6; // Good depth for fog effects
  
  // Create volumetric mesh with dynamic size
  console.log('Volumetric Setup - Creating mesh with dimensions:', {width: initialWidth, height: initialHeight, depth: initialDepth});
  let volumetricGeometry = new THREE.BoxGeometry(initialWidth, initialHeight, initialDepth);
  const volumetricMesh = new THREE.Mesh(volumetricGeometry, volumetricMaterial);
  volumetricMesh.receiveShadow = true;
  volumetricMesh.position.set(0, initialHeight / 2, 0); // Center over ground
  volumetricMesh.layers.disableAll();
  volumetricMesh.layers.enable(LAYER_VOLUMETRIC_LIGHTING);
  scene.add(volumetricMesh);
  console.log('Volumetric Setup - Mesh created and added to scene:', volumetricMesh.position);
  
  // Create volumetric lights positioned to create god rays through slits
  const pointLight = new THREE.PointLight(0xf9bb50, 0, 100); // Disabled by default
  pointLight.castShadow = true;
  pointLight.position.set(-5, 12, -8); // Behind and above the wall
  pointLight.layers.enable(LAYER_VOLUMETRIC_LIGHTING);
  scene.add(pointLight);
  console.log('Volumetric Setup - Point light created:', pointLight.position, 'intensity:', pointLight.intensity);
  
  // Main spotlight for dramatic god rays
  const spotLight = new THREE.SpotLight(0xffffff, 0);
  spotLight.position.set(8, 18, -12); // Behind and above at an angle
  spotLight.angle = Math.PI / 3; // Wider cone
  spotLight.penumbra = 0.8;
  spotLight.decay = 1.5;
  spotLight.distance = 0;
  spotLight.castShadow = true;
  spotLight.shadow.intensity = 0.95;
  spotLight.shadow.mapSize.width = 2048; // Higher resolution for sharper shadows
  spotLight.shadow.mapSize.height = 2048;
  spotLight.shadow.camera.near = 0.5;
  spotLight.shadow.camera.far = 150;
  spotLight.shadow.focus = 1;
  spotLight.shadow.bias = -0.001;
  spotLight.layers.enable(LAYER_VOLUMETRIC_LIGHTING);
  spotLight.target.position.set(0, 0, 0); // Target ground level for proper shadow projection
  scene.add(spotLight.target);
  scene.add(spotLight);
  console.log('Volumetric Setup - Spot light created:', spotLight.position, 'intensity:', spotLight.intensity);
  
  // Setup post-processing
  const postProcessing = new THREE.PostProcessing(renderer);
  
  // Volumetric lighting intensity
  const volumetricLightingIntensity = uniform(2);
  
  // Volumetric layer
  const volumetricLayer = new THREE.Layers();
  volumetricLayer.disableAll();
  volumetricLayer.enable(LAYER_VOLUMETRIC_LIGHTING);
  
  // Scene pass (full resolution)
  const scenePass = pass(scene, camera);
  const sceneDepth = scenePass.getTextureNode('depth');
  
  // Apply occlusion depth to volumetric material
  volumetricMaterial.depthNode = sceneDepth.sample(screenUV);
  
  // Volumetric pass (reduced resolution for performance)
  const volumetricPass = pass(scene, camera, { depthBuffer: false });
  volumetricPass.setLayers(volumetricLayer);
  volumetricPass.setResolution(0.5);
  
  // Denoise and compose
  const denoiseStrength = uniform(1);
  const blurredVolumetricPass = gaussianBlur(volumetricPass, denoiseStrength);
  const scenePassColor = scenePass.add(blurredVolumetricPass.mul(volumetricLightingIntensity));
  
  postProcessing.outputNode = scenePassColor;
  
  // Store uniforms for GUI access
  const uniforms = {
    smokeAmount,
    volumetricLightingIntensity,
    denoiseStrength,
    volumetricPass,
    blurredVolumetricPass,
    scenePass
  };

  // Volume control system
  const volumeControl = {
    width: initialWidth,
    height: initialHeight,
    depth: initialDepth,
    positionX: 0,
    positionY: initialHeight / 2,
    positionZ: 0,
    updateVolume: () => {
      // Dispose old geometry
      volumetricGeometry.dispose();
      
      // Create new geometry with updated dimensions
      volumetricGeometry = new THREE.BoxGeometry(volumeControl.width, volumeControl.height, volumeControl.depth);
      volumetricMesh.geometry = volumetricGeometry;
      
      // Update position
      volumetricMesh.position.set(volumeControl.positionX, volumeControl.positionY, volumeControl.positionZ);
    }
  };

  const system = {
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
  
  console.log('Volumetric Setup - System created successfully:', {
    hasMesh: !!volumetricMesh,
    hasPointLight: !!pointLight,
    hasSpotLight: !!spotLight,
    hasPostProcessing: !!postProcessing,
    hasUniforms: !!uniforms,
    hasVolumeControl: !!volumeControl
  });
  
  return system;
}

export function cleanupVolumetricLighting(system: VolumetricLightingSystem, scene: THREE.Scene): void {
  if (system.volumetricMesh) {
    scene.remove(system.volumetricMesh);
    system.volumetricMesh.geometry.dispose();
    (system.volumetricMesh.material as THREE.Material).dispose();
    system.volumetricMesh = null;
  }
  if (system.pointLight) {
    scene.remove(system.pointLight);
    system.pointLight = null;
  }
  if (system.spotLight) {
    scene.remove(system.spotLight);
    scene.remove(system.spotLight.target);
    system.spotLight = null;
  }
  if (system.postProcessing) {
    system.postProcessing = null;
  }
  system.uniforms = null;
  system.animationControl = null;
  system.volumeControl = null;
}

export function animateVolumetricLights(system: VolumetricLightingSystem): void {
  const control = system.animationControl;
  if (!control || !system.pointLight || !system.spotLight) return;
  
  const animationEnabled = control.enableLightAnimation;
  const currentTime = performance.now() * 0.001;
  
  // Check for manual position changes (detect if user moved lights manually)
  if (control.lastManualPositions.spotLight && control.lastManualPositions.pointLight) {
    const spotMoved = !system.spotLight.position.equals(control.lastManualPositions.spotLight);
    const pointMoved = !system.pointLight.position.equals(control.lastManualPositions.pointLight);
    
    if (spotMoved || pointMoved) {
      control.manualOverride = true;
      control.manualOverrideTime = currentTime;
    }
  }
  
  // Resume animation 5 seconds after last manual change
  if (control.manualOverride && (currentTime - control.manualOverrideTime) > 5.0) {
    control.manualOverride = false;
  }
  
  // Only animate if enabled and not in manual override mode
  if (animationEnabled && !control.manualOverride) {
    const scale = 3.0;
    
    // Animate point light in gentle motion behind the wall
    system.pointLight.position.x = Math.sin(currentTime * 0.5) * scale - 5;
    system.pointLight.position.y = Math.cos(currentTime * 0.3) * 2 + 12;
    system.pointLight.position.z = Math.cos(currentTime * 0.4) * 2 - 8;
    
    // Animate spot light to create sweeping god rays
    system.spotLight.position.x = Math.cos(currentTime * 0.2) * 4 + 8;
    system.spotLight.position.y = Math.sin(currentTime * 0.15) * 3 + 18;
    system.spotLight.position.z = -12 + Math.sin(currentTime * 0.1) * 2;
    system.spotLight.lookAt(0, 3, 0);
  }
  
  // Store current positions for next frame comparison
  control.lastManualPositions.spotLight = system.spotLight.position.clone();
  control.lastManualPositions.pointLight = system.pointLight.position.clone();
}

// ============================================================================
// GUI CONTROLS
// ============================================================================

export function setupVolumetricGUI(
  system: VolumetricLightingSystem,
  volumetricFolder: any,
  lights: { ambientLight: THREE.AmbientLight; directionalLight: THREE.DirectionalLight } | null,
  lightConfig: { intensity: number }
): void {
  if (!system.uniforms || !system.volumetricMesh) return;

  const uniforms = system.uniforms;
  
  // Ray marching controls
  const rayMarching = volumetricFolder.addFolder('Ray Marching');
  rayMarching.add((system.volumetricMesh.material as any), 'steps', 2, 12, 1).name('Steps');
  rayMarching.add(uniforms.denoiseStrength, 'value', 0, 1, 0.1).name('Denoise Strength');
  
  const params = {
    resolution: uniforms.volumetricPass.getResolution()
  };
  rayMarching.add(params, 'resolution', 0.1, 0.5, 0.05).name('Resolution').onChange((resolution: number) => {
    uniforms.volumetricPass.setResolution(resolution);
  });
  
  // Individual Light Controls
  const lightControls = {
    // Directional light controls
    directionalEnabled: false,
    directionalColor: '#ffffff',
    // Point light controls  
    pointEnabled: false,
    pointColor: '#f9bb50',
    // Spot light controls
    spotEnabled: false,
    spotColor: '#ffffff'
  };
  
  // Directional Light
  const dirLightFolder = volumetricFolder.addFolder('Directional Light');
  dirLightFolder.add(lightControls, 'directionalEnabled').name('Enable').onChange((enabled: boolean) => {
    if (lights?.directionalLight) {
      lights.directionalLight.intensity = enabled ? lightConfig.intensity : 0;
    }
  });
  dirLightFolder.addColor(lightControls, 'directionalColor').name('Color').onChange((color: string) => {
    if (lights?.directionalLight) {
      lights.directionalLight.color.setHex(parseInt(color.replace('#', '0x')));
    }
  });
  if (lights?.directionalLight) {
    dirLightFolder.add(lights.directionalLight, 'intensity', 0, 50, 0.1).name('Intensity');
  }
  
  // Point Light
  const pointLightFolder = volumetricFolder.addFolder('Point Light');
  pointLightFolder.add(lightControls, 'pointEnabled').name('Enable').onChange((enabled: boolean) => {
    if (system.pointLight) {
      system.pointLight.intensity = enabled ? 3 : 0;
    }
  });
  pointLightFolder.addColor(lightControls, 'pointColor').name('Color').onChange((color: string) => {
    if (system.pointLight) {
      system.pointLight.color.setHex(parseInt(color.replace('#', '0x')));
    }
  });
  if (system.pointLight) {
    pointLightFolder.add(system.pointLight, 'intensity', 0, 20, 0.1).name('Intensity');
    pointLightFolder.add(system.pointLight.position, 'x', -100, 100, 0.5).name('Position X');
    pointLightFolder.add(system.pointLight.position, 'y', 0, 100, 0.5).name('Position Y');
    pointLightFolder.add(system.pointLight.position, 'z', -100, 100, 0.5).name('Position Z');
  }
  
  // Spot Light
  const spotLightFolder = volumetricFolder.addFolder('Spot Light');
  spotLightFolder.add(lightControls, 'spotEnabled').name('Enable').onChange((enabled: boolean) => {
    if (system.spotLight) {
      system.spotLight.intensity = enabled ? 200 : 0;
    }
  });
  spotLightFolder.addColor(lightControls, 'spotColor').name('Color').onChange((color: string) => {
    if (system.spotLight) {
      system.spotLight.color.setHex(parseInt(color.replace('#', '0x')));
    }
  });
  if (system.spotLight) {
    spotLightFolder.add(system.spotLight, 'intensity', 0, 1000, 5).name('Intensity');
    spotLightFolder.add(system.spotLight.position, 'x', -100, 100, 0.5).name('Position X');
    spotLightFolder.add(system.spotLight.position, 'y', 0, 150, 0.5).name('Position Y');
    spotLightFolder.add(system.spotLight.position, 'z', -100, 100, 0.5).name('Position Z');
    spotLightFolder.add(system.spotLight, 'angle', 0.1, Math.PI / 2, 0.01).name('Cone Angle');
    spotLightFolder.add(system.spotLight, 'penumbra', 0, 1, 0.01).name('Penumbra');
  }
  
  // Fog Volume Controls
  if (system.volumeControl) {
    const volumeFolder = volumetricFolder.addFolder('Fog Volume');
    volumeFolder.add(system.volumeControl, 'width', 5, 1000, 1).name('Width').onChange(() => {
      system.volumeControl?.updateVolume();
    });
    volumeFolder.add(system.volumeControl, 'height', 2, 200, 1).name('Height').onChange(() => {
      system.volumeControl?.updateVolume();
    });
    volumeFolder.add(system.volumeControl, 'depth', 5, 1000, 1).name('Depth').onChange(() => {
      system.volumeControl?.updateVolume();
    });
    volumeFolder.add(system.volumeControl, 'positionX', -500, 500, 1).name('Position X').onChange(() => {
      system.volumeControl?.updateVolume();
    });
    volumeFolder.add(system.volumeControl, 'positionY', -50, 200, 1).name('Position Y').onChange(() => {
      system.volumeControl?.updateVolume();
    });
    volumeFolder.add(system.volumeControl, 'positionZ', -500, 500, 1).name('Position Z').onChange(() => {
      system.volumeControl?.updateVolume();
    });
    volumeFolder.open();
  }

  // Global volumetric settings
  const globalFolder = volumetricFolder.addFolder('Global Settings');
  globalFolder.add(uniforms.volumetricLightingIntensity, 'value', 0, 10, 0.1).name('Fog Intensity');
  globalFolder.add(uniforms.smokeAmount, 'value', 0, 10, 0.1).name('Smoke Amount');
  
  // Debug controls
  const debugControls = {
    showDepthBuffer: false,
    debugOcclusion: false
  };
  
  globalFolder.add(debugControls, 'showDepthBuffer').name('Debug: Show Depth Buffer').onChange((show: boolean) => {
    if (show && system.postProcessing) {
      // Temporarily show depth buffer instead of volumetric
      system.postProcessing.outputNode = uniforms.scenePass.getTextureNode('depth');
    } else if (system.postProcessing) {
      // Restore normal volumetric rendering
      system.postProcessing.outputNode = uniforms.scenePass.add(uniforms.blurredVolumetricPass.mul(uniforms.volumetricLightingIntensity));
    }
  });
  
  // Animation control
  if (system.animationControl) {
    globalFolder.add(system.animationControl, 'enableLightAnimation').name('Animate Lights');
    
    // Add status display for manual override
    const animationStatus = {
      get status() {
        if (!system.animationControl?.enableLightAnimation) return 'Animation Disabled';
        if (system.animationControl?.manualOverride) return 'Manual Override Active';
        return 'Animation Active';
      }
    };
    globalFolder.add(animationStatus, 'status').name('Animation Status').listen();
  }
  
  volumetricFolder.open();
}
