import { deriveSeed, SeededRandom, SOLAR_MASS_KG, SOLAR_RADIUS_METERS } from "../core";
import type { SpectralType, StarDescriptor } from "./types";

interface SpectralAnchor {
  type: SpectralType;
  temperature: number;
  massSolar: number;
  radiusSolar: number;
  luminositySolar: number;
  color: string;
}

const SPECTRAL_ANCHORS: Record<SpectralType, SpectralAnchor> = {
  A: { type: "A", temperature: 8_400, massSolar: 1.85, radiusSolar: 1.65, luminositySolar: 12, color: "#a6c8ff" },
  F: { type: "F", temperature: 6_720, massSolar: 1.32, radiusSolar: 1.27, luminositySolar: 3.3, color: "#e7eaff" },
  G: { type: "G", temperature: 5_770, massSolar: 1.0, radiusSolar: 1.0, luminositySolar: 1.0, color: "#ffe4a3" },
  K: { type: "K", temperature: 4_660, massSolar: 0.78, radiusSolar: 0.78, luminositySolar: 0.34, color: "#ffad67" },
  M: { type: "M", temperature: 3_350, massSolar: 0.37, radiusSolar: 0.42, luminositySolar: 0.032, color: "#ff6a82" },
};

export function selectSpectralType(random: SeededRandom): SpectralType {
  const value = random.next();
  if (value < 0.56) return "M";
  if (value < 0.78) return "K";
  if (value < 0.92) return "G";
  if (value < 0.985) return "F";
  return "A";
}

export interface StarGenerationOptions {
  spectralType?: SpectralType;
  name?: string;
  color?: string;
}

export function generateStar(
  systemId: string,
  systemSeed: number,
  index: number,
  options: StarGenerationOptions = {},
): StarDescriptor {
  const seed = deriveSeed(systemSeed, "star", index);
  const random = new SeededRandom(seed);
  const spectralType = options.spectralType ?? selectSpectralType(random);
  const anchor = SPECTRAL_ANCHORS[spectralType];
  const spectralSubtype = random.int(0, 10);
  const variance = random.range(0.92, 1.08);
  const massSolar = anchor.massSolar * variance;

  return {
    id: `${systemId}:star:${index}`,
    systemId,
    name: options.name ?? `${String.fromCharCode(65 + index)} ${spectralType}${spectralSubtype}V`,
    seed,
    spectralType,
    spectralSubtype,
    temperatureKelvin: Math.round(anchor.temperature * (1.04 - spectralSubtype * 0.008) * variance ** 0.16),
    massKg: massSolar * SOLAR_MASS_KG,
    radiusMeters: anchor.radiusSolar * variance ** 0.8 * SOLAR_RADIUS_METERS,
    luminositySolar: anchor.luminositySolar * variance ** 3.5,
    color: options.color ?? anchor.color,
  };
}
