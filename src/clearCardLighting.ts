export type ToneMappingMode =
  | 'none'
  | 'linear'
  | 'reinhard'
  | 'cineon'
  | 'aces'
  | 'agx'
  | 'neutral';

type EnvironmentMode = 'sky' | 'room' | 'none';
export type LightStage = 'all' | 'pack' | 'card';

export type Vector3Config = {
  x: number;
  y: number;
  z: number;
};

export type SkyEnvironmentConfig = {
  resolution: 128 | 256 | 512 | 1024;
  groundColor: string;
  groundIntensity: number;
  horizonColor: string;
  horizonIntensity: number;
  zenithColor: string;
  zenithIntensity: number;
  keyColor: string;
  keyIntensity: number;
  keyLatitude: number;
  keyLongitude: number;
  keyRadius: number;
  keyFalloff: number;
};

type ScopedLightConfig = {
  enabled: boolean;
  stage: LightStage;
  intensity: number;
};

type AmbientLightConfig = ScopedLightConfig & {
  color: string;
};

type HemisphereLightConfig = ScopedLightConfig & {
  skyColor: string;
  groundColor: string;
};

type DirectionalLightConfig = ScopedLightConfig & {
  color: string;
  position: Vector3Config;
  target: Vector3Config;
};

type PointLightConfig = ScopedLightConfig & {
  color: string;
  position: Vector3Config;
  distance: number;
  decay: number;
};

type AreaLightConfig = ScopedLightConfig & {
  color: string;
  position: Vector3Config;
  target: Vector3Config;
  width: number;
  height: number;
};

type SpotLightConfig = PointLightConfig & {
  target: Vector3Config;
  angle: number;
  penumbra: number;
};

export type ClearCardLightingConfig = {
  renderer: {
    toneMapping: ToneMappingMode;
    exposure: number;
  };
  environment: {
    mode: EnvironmentMode;
    intensity: number;
    rotation: number;
    sky: SkyEnvironmentConfig;
  };
  ambient: AmbientLightConfig;
  hemisphere: HemisphereLightConfig;
  directional: DirectionalLightConfig;
  rim: DirectionalLightConfig;
  area: AreaLightConfig;
  point: PointLightConfig;
  spot: SpotLightConfig;
  transmission: {
    cardColor: string;
    cardAlpha: number;
    packColor: string;
    packAlpha: number;
  };
};

type LightingOverrides = {
  renderer?: Partial<ClearCardLightingConfig['renderer']>;
  environment?: Partial<Omit<ClearCardLightingConfig['environment'], 'sky'>> & {
    sky?: Partial<SkyEnvironmentConfig>;
  };
  ambient?: Partial<AmbientLightConfig>;
  hemisphere?: Partial<HemisphereLightConfig>;
  directional?: Partial<DirectionalLightConfig>;
  rim?: Partial<DirectionalLightConfig>;
  area?: Partial<AreaLightConfig>;
  point?: Partial<PointLightConfig>;
  spot?: Partial<SpotLightConfig>;
  transmission?: Partial<ClearCardLightingConfig['transmission']>;
};

const BALANCED_LIGHTING: ClearCardLightingConfig = {
  renderer: {
    toneMapping: 'linear',
    exposure: 1,
  },
  environment: {
    mode: 'sky',
    intensity: 1,
    rotation: 0,
    sky: {
      resolution: 512,
      groundColor: '#e9f3ff',
      groundIntensity: 0.1,
      horizonColor: '#eef7ff',
      horizonIntensity: 0.7,
      zenithColor: '#f1f6ff',
      zenithIntensity: 1.24,
      keyColor: '#ffffff',
      keyIntensity: 32,
      keyLatitude: 0,
      keyLongitude: 0,
      keyRadius: 45,
      keyFalloff: 1,
    },
  },
  ambient: {
    enabled: true,
    stage: 'all',
    color: '#ffffff',
    intensity: 0.3,
  },
  hemisphere: {
    enabled: false,
    stage: 'all',
    skyColor: '#dce8ff',
    groundColor: '#2c2018',
    intensity: 0.4,
  },
  directional: {
    enabled: true,
    stage: 'pack',
    color: '#ffffff',
    intensity: 1.4,
    position: { x: 0.4, y: 0, z: 8.6 },
    target: { x: 0, y: 0, z: 0 },
  },
  rim: {
    enabled: false,
    stage: 'all',
    color: '#d8e6ff',
    intensity: 1.5,
    position: { x: -2, y: 1.5, z: -3 },
    target: { x: 0, y: 0, z: 0 },
  },
  area: {
    enabled: false,
    stage: 'all',
    color: '#fff0db',
    intensity: 6,
    position: { x: 2.5, y: 3, z: 4 },
    target: { x: 0, y: 0, z: 0 },
    width: 4,
    height: 3,
  },
  point: {
    enabled: false,
    stage: 'all',
    color: '#ffd9b0',
    intensity: 40,
    position: { x: 2, y: 2, z: 3 },
    distance: 0,
    decay: 2,
  },
  spot: {
    enabled: false,
    stage: 'all',
    color: '#ffffff',
    intensity: 80,
    position: { x: -2, y: 3, z: 4 },
    target: { x: 0, y: 0, z: 0 },
    angle: 30,
    penumbra: 0.5,
    distance: 0,
    decay: 2,
  },
  transmission: {
    cardColor: '#191919',
    cardAlpha: 0.72,
    packColor: '#777777',
    packAlpha: 0.62,
  },
};

function cloneConfig(config: ClearCardLightingConfig): ClearCardLightingConfig {
  return JSON.parse(JSON.stringify(config)) as ClearCardLightingConfig;
}

function createConfig(overrides: LightingOverrides = {}): ClearCardLightingConfig {
  const base = cloneConfig(BALANCED_LIGHTING);
  return {
    ...base,
    renderer: { ...base.renderer, ...overrides.renderer },
    environment: {
      ...base.environment,
      ...overrides.environment,
      sky: { ...base.environment.sky, ...overrides.environment?.sky },
    },
    ambient: { ...base.ambient, ...overrides.ambient },
    hemisphere: { ...base.hemisphere, ...overrides.hemisphere },
    directional: { ...base.directional, ...overrides.directional },
    rim: { ...base.rim, ...overrides.rim },
    area: { ...base.area, ...overrides.area },
    point: { ...base.point, ...overrides.point },
    spot: { ...base.spot, ...overrides.spot },
    transmission: { ...base.transmission, ...overrides.transmission },
  };
}

const CLEAR_CARD_LIGHTING_BASE_PRESETS = [
  {
    id: 'light-upcoming',
    label: 'LightUpcoming',
    description: 'Upcoming Clear Cards lighting with a high neutral point source.',
    config: createConfig({
      renderer: {
        toneMapping: 'aces',
        exposure: 1.25,
      },
      environment: {
        mode: 'room',
        intensity: 1,
        rotation: 121,
        sky: {
          resolution: 512,
          groundColor: '#e9f3ff',
          groundIntensity: 0.1,
          horizonColor: '#eef7ff',
          horizonIntensity: 0.7,
          zenithColor: '#f1f6ff',
          zenithIntensity: 1.24,
          keyColor: '#ffffff',
          keyIntensity: 32,
          keyLatitude: 0,
          keyLongitude: 0,
          keyRadius: 45,
          keyFalloff: 1,
        },
      },
      ambient: {
        enabled: false,
        stage: 'all',
        color: '#ffffff',
        intensity: 0,
      },
      hemisphere: {
        enabled: true,
        stage: 'all',
        skyColor: '#dce8ff',
        groundColor: '#2c2018',
        intensity: 0.65,
      },
      directional: {
        enabled: false,
        stage: 'pack',
        color: '#ffffff',
        intensity: 1.4,
        position: { x: 0.4, y: 0, z: 8.6 },
        target: { x: 0, y: 0, z: 0 },
      },
      rim: {
        enabled: false,
        stage: 'all',
        color: '#d8e6ff',
        intensity: 1.5,
        position: { x: -2, y: 1.5, z: -3 },
        target: { x: 0, y: 0, z: 0 },
      },
      area: {
        enabled: true,
        stage: 'all',
        color: '#fff0db',
        intensity: 0,
        position: { x: 2.5, y: 3, z: 4 },
        target: { x: 0, y: 0, z: 0 },
        width: 4,
        height: 3,
      },
      point: {
        enabled: true,
        stage: 'all',
        color: '#ffffff',
        intensity: 17,
        position: { x: -3.9, y: 5.5, z: 3 },
        distance: 0,
        decay: 0.4,
      },
      spot: {
        enabled: true,
        stage: 'all',
        color: '#c8ddff',
        intensity: 110,
        position: { x: -3, y: 4, z: 4 },
        target: { x: 0, y: 0, z: 0 },
        angle: 34,
        penumbra: 0.65,
        distance: 0,
        decay: 2,
      },
      transmission: {
        cardColor: '#191919',
        cardAlpha: 0.3,
        packColor: '#777777',
        packAlpha: 0.13,
      },
    }),
  },
  {
    id: 'dgpm-light-upcoming-white-bg',
    label: 'Dgpm_LightUpcomingWhiteBG',
    description: 'Upcoming Clear Cards lighting positioned for the light storefront.',
    config: createConfig({
      renderer: {
        toneMapping: 'aces',
        exposure: 1.25,
      },
      environment: {
        mode: 'room',
        intensity: 1,
        rotation: 121,
        sky: {
          resolution: 512,
          groundColor: '#e9f3ff',
          groundIntensity: 0.1,
          horizonColor: '#eef7ff',
          horizonIntensity: 0.7,
          zenithColor: '#f1f6ff',
          zenithIntensity: 1.24,
          keyColor: '#ffffff',
          keyIntensity: 32,
          keyLatitude: 0,
          keyLongitude: 0,
          keyRadius: 45,
          keyFalloff: 1,
        },
      },
      ambient: {
        enabled: false,
        stage: 'all',
        color: '#ffffff',
        intensity: 0,
      },
      hemisphere: {
        enabled: true,
        stage: 'all',
        skyColor: '#dce8ff',
        groundColor: '#2c2018',
        intensity: 0.65,
      },
      directional: {
        enabled: false,
        stage: 'pack',
        color: '#ffffff',
        intensity: 1.4,
        position: { x: 0.4, y: 0, z: 8.6 },
        target: { x: 0, y: 0, z: 0 },
      },
      rim: {
        enabled: false,
        stage: 'all',
        color: '#d8e6ff',
        intensity: 1.5,
        position: { x: -2, y: 1.5, z: -3 },
        target: { x: 0, y: 0, z: 0 },
      },
      area: {
        enabled: true,
        stage: 'all',
        color: '#fff0db',
        intensity: 0,
        position: { x: 2.5, y: 3, z: 4 },
        target: { x: 0, y: 0, z: 0 },
        width: 4,
        height: 3,
      },
      point: {
        enabled: true,
        stage: 'all',
        color: '#ffffff',
        intensity: 17,
        position: { x: -6.5, y: 1.2, z: 3 },
        distance: 0,
        decay: 0.4,
      },
      spot: {
        enabled: true,
        stage: 'all',
        color: '#c8ddff',
        intensity: 110,
        position: { x: -3, y: 4, z: 4 },
        target: { x: 0, y: 0, z: 0 },
        angle: 34,
        penumbra: 0.65,
        distance: 0,
        decay: 2,
      },
      transmission: {
        cardColor: '#191919',
        cardAlpha: 0.3,
        packColor: '#777777',
        packAlpha: 0.13,
      },
    }),
  },
  {
    id: 'dgpm-light-test-1',
    label: 'Dgpm_LightTest1',
    description: 'Room reflections with a warm point light and cool spotlight.',
    config: createConfig({
      renderer: {
        toneMapping: 'aces',
        exposure: 1.25,
      },
      environment: {
        mode: 'room',
        intensity: 1,
        rotation: 121,
        sky: {
          resolution: 512,
          groundColor: '#e9f3ff',
          groundIntensity: 0.1,
          horizonColor: '#eef7ff',
          horizonIntensity: 0.7,
          zenithColor: '#f1f6ff',
          zenithIntensity: 1.24,
          keyColor: '#ffffff',
          keyIntensity: 32,
          keyLatitude: 0,
          keyLongitude: 0,
          keyRadius: 45,
          keyFalloff: 1,
        },
      },
      ambient: {
        enabled: false,
        stage: 'all',
        color: '#ffffff',
        intensity: 0,
      },
      hemisphere: {
        enabled: true,
        stage: 'all',
        skyColor: '#dce8ff',
        groundColor: '#2c2018',
        intensity: 0.65,
      },
      directional: {
        enabled: false,
        stage: 'pack',
        color: '#ffffff',
        intensity: 1.4,
        position: { x: 0.4, y: 0, z: 8.6 },
        target: { x: 0, y: 0, z: 0 },
      },
      rim: {
        enabled: false,
        stage: 'all',
        color: '#d8e6ff',
        intensity: 1.5,
        position: { x: -2, y: 1.5, z: -3 },
        target: { x: 0, y: 0, z: 0 },
      },
      area: {
        enabled: true,
        stage: 'all',
        color: '#fff0db',
        intensity: 0,
        position: { x: 2.5, y: 3, z: 4 },
        target: { x: 0, y: 0, z: 0 },
        width: 4,
        height: 3,
      },
      point: {
        enabled: true,
        stage: 'all',
        color: '#ffd7b0',
        intensity: 55,
        position: { x: 2.5, y: 1.5, z: 3 },
        distance: 0,
        decay: 2,
      },
      spot: {
        enabled: true,
        stage: 'all',
        color: '#c8ddff',
        intensity: 110,
        position: { x: -3, y: 4, z: 4 },
        target: { x: 0, y: 0, z: 0 },
        angle: 34,
        penumbra: 0.65,
        distance: 0,
        decay: 2,
      },
      transmission: {
        cardColor: '#191919',
        cardAlpha: 0.3,
        packColor: '#777777',
        packAlpha: 0.13,
      },
    }),
  },
  {
    id: 'ivan-wip',
    label: 'Ivan WIP',
    description: 'Soft studio with an aces curve and a gentler key.',
    config: createConfig({
      renderer: { toneMapping: 'aces', exposure: 1.1 },
      environment: {
        intensity: 1.2,
        sky: {
          groundColor: '#d8deea',
          groundIntensity: 0.35,
          horizonColor: '#ffffff',
          horizonIntensity: 1.5,
          zenithColor: '#dce8ff',
          zenithIntensity: 1.45,
          keyColor: '#fff6e8',
          keyIntensity: 4,
          keyLatitude: 24,
          keyLongitude: -28,
          keyRadius: 72,
          keyFalloff: 2,
        },
      },
      ambient: { intensity: 0.18 },
      hemisphere: { enabled: true, intensity: 0.25 },
      directional: {
        enabled: true,
        stage: 'all',
        intensity: 0.7,
        position: { x: 2, y: 3, z: 4 },
      },
      rim: { enabled: true, intensity: 0.45 },
    }),
  },
  {
    id: 'balanced',
    label: 'Balanced sky',
    description: 'Current flare-safe spherical setup.',
    config: createConfig(),
  },
  {
    id: 'original-hot',
    label: 'Original hot sky',
    description: 'The earlier high-energy reflective setup.',
    config: createConfig({
      environment: {
        sky: {
          groundIntensity: 0.05,
          horizonIntensity: 0.35,
          zenithIntensity: 0.62,
          keyIntensity: 521,
          keyLatitude: 12,
        },
      },
    }),
  },
  {
    id: 'soft-studio',
    label: 'Soft studio',
    description: 'Wide gradients with gentle direct fill.',
    config: createConfig({
      renderer: { toneMapping: 'neutral', exposure: 1.1 },
      environment: {
        intensity: 1.2,
        sky: {
          groundColor: '#d8deea',
          groundIntensity: 0.35,
          horizonColor: '#ffffff',
          horizonIntensity: 1.1,
          zenithColor: '#dce8ff',
          zenithIntensity: 1.45,
          keyColor: '#fff6e8',
          keyIntensity: 10,
          keyLatitude: 24,
          keyLongitude: -28,
          keyRadius: 72,
          keyFalloff: 2,
        },
      },
      ambient: { intensity: 0.18 },
      hemisphere: { enabled: true, intensity: 0.25 },
      directional: {
        enabled: true,
        stage: 'all',
        intensity: 0.7,
        position: { x: 2, y: 3, z: 4 },
      },
      rim: { enabled: true, intensity: 0.45 },
    }),
  },
  {
    id: 'room',
    label: 'Room environment',
    description: 'Three.js studio room with a clean key.',
    config: createConfig({
      renderer: { toneMapping: 'aces', exposure: 1 },
      environment: { mode: 'room', intensity: 1 },
      ambient: { intensity: 0.12 },
      directional: {
        enabled: true,
        stage: 'all',
        intensity: 1.1,
        position: { x: 2.5, y: 3, z: 4 },
      },
      rim: { enabled: false },
    }),
  },
  {
    id: 'area-studio',
    label: 'Area studio',
    description: 'Broad rectangular key for long, soft highlights.',
    config: createConfig({
      renderer: { toneMapping: 'neutral', exposure: 1.15 },
      environment: {
        intensity: 0.45,
        sky: {
          groundIntensity: 0.08,
          horizonIntensity: 0.28,
          zenithIntensity: 0.45,
          keyIntensity: 0,
        },
      },
      ambient: { intensity: 0.08 },
      directional: { enabled: false },
      area: {
        enabled: true,
        intensity: 10,
        position: { x: 2.5, y: 2.5, z: 4 },
        width: 5,
        height: 3,
      },
      rim: {
        enabled: true,
        color: '#9ebfff',
        intensity: 0.65,
      },
    }),
  },
  {
    id: 'dramatic-rim',
    label: 'Dramatic rim',
    description: 'Dark body, cool back edge, warm key.',
    config: createConfig({
      renderer: { toneMapping: 'agx', exposure: 1.25 },
      environment: {
        intensity: 0.55,
        sky: {
          groundColor: '#171b24',
          groundIntensity: 0.08,
          horizonColor: '#30394a',
          horizonIntensity: 0.25,
          zenithColor: '#60759c',
          zenithIntensity: 0.55,
          keyColor: '#ffd8aa',
          keyIntensity: 7,
          keyLatitude: 35,
          keyLongitude: 38,
          keyRadius: 32,
          keyFalloff: 2.5,
        },
      },
      ambient: { intensity: 0.04 },
      directional: {
        enabled: true,
        stage: 'all',
        color: '#ffd4a3',
        intensity: 1.15,
        position: { x: 3, y: 2.5, z: 4 },
      },
      rim: {
        enabled: true,
        color: '#8db7ff',
        intensity: 2.2,
        position: { x: -3, y: 2, z: -4 },
      },
    }),
  },
  {
    id: 'physical-rig',
    label: 'Physical light rig',
    description: 'No environment; hemisphere, point, and spot only.',
    config: createConfig({
      renderer: { toneMapping: 'aces', exposure: 1.15 },
      environment: { mode: 'none' },
      ambient: { enabled: false },
      hemisphere: { enabled: true, intensity: 0.65 },
      directional: { enabled: false },
      point: {
        enabled: true,
        color: '#ffd7b0',
        intensity: 55,
        position: { x: 2.5, y: 1.5, z: 3 },
      },
      spot: {
        enabled: true,
        color: '#c8ddff',
        intensity: 110,
        position: { x: -3, y: 4, z: 4 },
        angle: 34,
        penumbra: 0.65,
      },
    }),
  },
  {
    id: 'flat-reference',
    label: 'Flat reference',
    description: 'Neutral ambient illumination without reflections.',
    config: createConfig({
      renderer: { toneMapping: 'linear', exposure: 1 },
      environment: { mode: 'none' },
      ambient: { enabled: true, intensity: 1 },
      hemisphere: { enabled: false },
      directional: { enabled: false },
      rim: { enabled: false },
      area: { enabled: false },
      point: { enabled: false },
      spot: { enabled: false },
    }),
  },
] as const;

type ClearCardLightingBasePresetId = (typeof CLEAR_CARD_LIGHTING_BASE_PRESETS)[number]['id'];

function cloneClearCardLightingBasePreset(presetId: ClearCardLightingBasePresetId) {
  const preset = CLEAR_CARD_LIGHTING_BASE_PRESETS.find(
    (candidate) => candidate.id === presetId,
  );
  if (!preset) throw new Error(`Unknown Clear Card lighting base preset: ${presetId}`);
  return cloneConfig(preset.config);
}

const FINAL_CANDIDATE_SOURCE_PRESET_ID: ClearCardLightingBasePresetId =
  'dgpm-light-upcoming-white-bg';

function createFinalV1LightingConfig() {
  const config = cloneClearCardLightingBasePreset(FINAL_CANDIDATE_SOURCE_PRESET_ID);
  config.renderer.exposure = 1;
  config.environment.intensity = 1.8;
  config.spot.intensity = 109;
  config.transmission.packAlpha = 0.76;
  return config;
}

function createFinalV2LightingConfig() {
  const config = createFinalV1LightingConfig();
  config.transmission.packAlpha = 0.55;
  return config;
}

function createFinalV3LightingConfig(packAlpha: number) {
  const config = createFinalV1LightingConfig();
  config.transmission.packAlpha = packAlpha;
  return config;
}

function createFinalV4LightingConfig(packAlpha: number) {
  const config = createFinalV3LightingConfig(packAlpha);
  config.hemisphere.enabled = false;
  config.area.enabled = false;
  config.point.enabled = false;
  config.spot.enabled = false;
  return config;
}

export const CLEAR_CARD_LIGHTING_PRESETS = [
  {
    id: 'final_v4',
    label: 'final_v4',
    description: 'Final v4 lighting without hemisphere, area, point, or spot lights.',
    config: createFinalV4LightingConfig(0.55),
    darkModeConfig: createFinalV4LightingConfig(0.76),
  },
  {
    id: 'final_v3',
    label: 'final_v3',
    description: 'Final v3 lighting with color-scheme-aware pack transparency.',
    config: createFinalV3LightingConfig(0.55),
    darkModeConfig: createFinalV3LightingConfig(0.76),
  },
  {
    id: 'final_v2',
    label: 'final_v2',
    description: 'Final v2 lighting for Clear Cards unpacking.',
    config: createFinalV2LightingConfig(),
  },
  {
    id: 'final_v1',
    label: 'final_v1',
    description: 'Final v1 lighting for Clear Cards unpacking.',
    config: createFinalV1LightingConfig(),
  },
  {
    id: 'final_candidate',
    label: 'final_candidate',
    description: 'Final candidate based on the light storefront setup.',
    config: cloneClearCardLightingBasePreset(FINAL_CANDIDATE_SOURCE_PRESET_ID),
  },
  ...CLEAR_CARD_LIGHTING_BASE_PRESETS,
] as const;

export type ClearCardLightingPresetId = (typeof CLEAR_CARD_LIGHTING_PRESETS)[number]['id'];

export const DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID: ClearCardLightingPresetId = 'final_v4';
const CLEAR_CARD_LIGHTING_CONFIG_VERSION = 1;

export function createClearCardLightingPreset(
  presetId: ClearCardLightingPresetId = DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
  options: { darkMode?: boolean } = {},
): ClearCardLightingConfig {
  const preset =
    CLEAR_CARD_LIGHTING_PRESETS.find((candidate) => candidate.id === presetId) ??
    CLEAR_CARD_LIGHTING_PRESETS.find(
      (candidate) => candidate.id === DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
    ) ??
    CLEAR_CARD_LIGHTING_PRESETS[0];
  const config =
    options.darkMode && 'darkModeConfig' in preset ? preset.darkModeConfig : preset.config;
  return cloneConfig(config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyConfigShape(value: unknown, template: unknown, path: string): unknown {
  if (typeof template === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number.`);
    }
    return value;
  }
  if (typeof template === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`${path} must be a string.`);
    }
    return value;
  }
  if (typeof template === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`${path} must be true or false.`);
    }
    return value;
  }
  if (!isRecord(value) || !isRecord(template)) {
    throw new Error(`${path} must be an object.`);
  }

  return Object.fromEntries(
    Object.entries(template).map(([key, templateValue]) => {
      const sourceValue = Object.prototype.hasOwnProperty.call(value, key)
        ? value[key]
        : templateValue;
      return [key, copyConfigShape(sourceValue, templateValue, `${path}.${key}`)];
    }),
  );
}

function assertChoice<T extends string | number>(
  value: T,
  choices: readonly T[],
  path: string,
) {
  if (!choices.includes(value)) {
    throw new Error(`${path} has an unsupported value.`);
  }
}

function assertColor(value: string, path: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${path} must be a six-digit hex color.`);
  }
}

function assertRange(value: number, min: number, max: number, path: string) {
  if (value < min || value > max) {
    throw new Error(`${path} must be between ${min} and ${max}.`);
  }
}

export function parseClearCardLightingConfigJson(source: string): ClearCardLightingConfig {
  let rawValue: unknown;
  try {
    rawValue = JSON.parse(source);
  } catch {
    throw new Error('Clipboard does not contain valid JSON.');
  }

  let rawConfig = rawValue;
  if (
    isRecord(rawValue) &&
    Object.prototype.hasOwnProperty.call(rawValue, 'version')
  ) {
    if (rawValue.version !== CLEAR_CARD_LIGHTING_CONFIG_VERSION) {
      throw new Error('Lighting configuration version is not supported.');
    }
    rawConfig = rawValue.config;
  }

  const config = copyConfigShape(
    rawConfig,
    BALANCED_LIGHTING,
    'config',
  ) as ClearCardLightingConfig;

  assertChoice(
    config.renderer.toneMapping,
    ['none', 'linear', 'reinhard', 'cineon', 'aces', 'agx', 'neutral'],
    'config.renderer.toneMapping',
  );
  assertChoice(config.environment.mode, ['sky', 'room', 'none'], 'config.environment.mode');
  assertChoice(
    config.environment.sky.resolution,
    [128, 256, 512, 1024],
    'config.environment.sky.resolution',
  );

  const scopedLights = [
    ['ambient', config.ambient],
    ['hemisphere', config.hemisphere],
    ['directional', config.directional],
    ['rim', config.rim],
    ['area', config.area],
    ['point', config.point],
    ['spot', config.spot],
  ] as const;
  scopedLights.forEach(([name, light]) => {
    assertChoice(light.stage, ['all', 'pack', 'card'], `config.${name}.stage`);
  });

  const colors = [
    ['environment.sky.groundColor', config.environment.sky.groundColor],
    ['environment.sky.horizonColor', config.environment.sky.horizonColor],
    ['environment.sky.zenithColor', config.environment.sky.zenithColor],
    ['environment.sky.keyColor', config.environment.sky.keyColor],
    ['ambient.color', config.ambient.color],
    ['hemisphere.skyColor', config.hemisphere.skyColor],
    ['hemisphere.groundColor', config.hemisphere.groundColor],
    ['directional.color', config.directional.color],
    ['rim.color', config.rim.color],
    ['area.color', config.area.color],
    ['point.color', config.point.color],
    ['spot.color', config.spot.color],
    ['transmission.cardColor', config.transmission.cardColor],
    ['transmission.packColor', config.transmission.packColor],
  ] as const;
  colors.forEach(([path, color]) => assertColor(color, `config.${path}`));

  const ranges = [
    ['renderer.exposure', config.renderer.exposure, 0.1, 4],
    ['environment.intensity', config.environment.intensity, 0, 5],
    ['environment.rotation', config.environment.rotation, -180, 180],
    ['environment.sky.groundIntensity', config.environment.sky.groundIntensity, 0, 8],
    ['environment.sky.horizonIntensity', config.environment.sky.horizonIntensity, 0, 8],
    ['environment.sky.zenithIntensity', config.environment.sky.zenithIntensity, 0, 8],
    ['environment.sky.keyIntensity', config.environment.sky.keyIntensity, 0, 600],
    ['environment.sky.keyLatitude', config.environment.sky.keyLatitude, -90, 90],
    ['environment.sky.keyLongitude', config.environment.sky.keyLongitude, -180, 180],
    ['environment.sky.keyRadius', config.environment.sky.keyRadius, 2, 120],
    ['environment.sky.keyFalloff', config.environment.sky.keyFalloff, 0.1, 8],
    ['ambient.intensity', config.ambient.intensity, 0, 5],
    ['hemisphere.intensity', config.hemisphere.intensity, 0, 5],
    ['directional.intensity', config.directional.intensity, 0, 10],
    ['rim.intensity', config.rim.intensity, 0, 10],
    ['area.intensity', config.area.intensity, 0, 100],
    ['area.width', config.area.width, 0.1, 20],
    ['area.height', config.area.height, 0.1, 20],
    ['point.intensity', config.point.intensity, 0, 500],
    ['point.distance', config.point.distance, 0, 50],
    ['point.decay', config.point.decay, 0, 4],
    ['spot.intensity', config.spot.intensity, 0, 500],
    ['spot.angle', config.spot.angle, 1, 90],
    ['spot.penumbra', config.spot.penumbra, 0, 1],
    ['spot.distance', config.spot.distance, 0, 50],
    ['spot.decay', config.spot.decay, 0, 4],
    ['transmission.cardAlpha', config.transmission.cardAlpha, 0, 1],
    ['transmission.packAlpha', config.transmission.packAlpha, 0, 1],
  ] as const;
  ranges.forEach(([path, value, min, max]) => {
    assertRange(value, min, max, `config.${path}`);
  });

  const vectors = [
    ['directional.position', config.directional.position],
    ['directional.target', config.directional.target],
    ['rim.position', config.rim.position],
    ['rim.target', config.rim.target],
    ['area.position', config.area.position],
    ['area.target', config.area.target],
    ['point.position', config.point.position],
    ['spot.position', config.spot.position],
    ['spot.target', config.spot.target],
  ] as const;
  vectors.forEach(([path, vector]) => {
    (['x', 'y', 'z'] as const).forEach((axis) => {
      assertRange(vector[axis], -10, 10, `config.${path}.${axis}`);
    });
  });

  return config;
}

export function serializeClearCardLightingConfig(config: ClearCardLightingConfig) {
  return JSON.stringify(
    {
      version: CLEAR_CARD_LIGHTING_CONFIG_VERSION,
      config,
    },
    null,
    2,
  );
}
