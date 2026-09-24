export interface OrbitalCloudCandidate {
  readonly bodyId: string;
  readonly diameterPixels: number;
}

export interface OrbitalCloudSelection {
  readonly bodyId?: string;
  readonly opacity: number;
}

/** Keep one remote cloud draw set, with hysteresis and a fade before replacing it. */
export function advanceOrbitalCloudSelection(
  previous: OrbitalCloudSelection,
  candidates: readonly OrbitalCloudCandidate[],
  options: { allowed: boolean; minimumDiameterPixels: number; deltaSeconds: number },
): OrbitalCloudSelection {
  const minimum = Math.max(1, options.minimumDiameterPixels);
  const visible = candidates.filter((candidate) => Number.isFinite(candidate.diameterPixels) &&
    candidate.diameterPixels >= 0);
  const current = visible.find((candidate) => candidate.bodyId === previous.bodyId);
  const strongest = options.allowed ? visible
    .filter((candidate) => candidate.diameterPixels >= minimum)
    .sort((a, b) => b.diameterPixels - a.diameterPixels || a.bodyId.localeCompare(b.bodyId))[0] : undefined;
  const retained = options.allowed && current && current.diameterPixels >= minimum * 0.75;
  const desired = retained && (!strongest || strongest.bodyId === current.bodyId ||
    strongest.diameterPixels < current.diameterPixels * 1.25)
    ? current : strongest;
  const step = Math.min(0.1, Math.max(0, options.deltaSeconds)) / 0.45;
  const opacity = current ? Math.max(0, Math.min(1, previous.opacity)) : 0;

  if (current && current.bodyId !== desired?.bodyId && opacity > step) {
    return { bodyId: current.bodyId, opacity: opacity - step };
  }
  if (!desired) return { opacity: 0 };
  if (current?.bodyId !== desired.bodyId) {
    // The outgoing body reaches zero before another one consumes its draw
    // budget. The new body starts from zero, never from the outgoing alpha.
    return { bodyId: desired.bodyId, opacity: Math.min(1, step) };
  }
  return { bodyId: current.bodyId, opacity: Math.min(1, opacity + step) };
}
