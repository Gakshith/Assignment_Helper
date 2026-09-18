/**
 * Invariant I15: you can never be unknowingly in a bypass.
 *
 * This is the UI third of the dev-build guard; the startup banner and the PDF
 * metadata are the other two. `GET /api/status` reports `dev_build` and a `bypasses`
 * object, and EVERY active one becomes a badge that does not go away.
 *
 * `deriveBadges` is pure and knows nothing about the DOM, so the rule "an active
 * bypass is always badged" is a unit test rather than a screenshot. It refuses a
 * malformed payload instead of defaulting to "no bypasses": reading a broken status
 * as an all-clear is the exact failure I15 exists to prevent.
 */

import { api } from './session';

export interface Badge {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly kind: 'dev' | 'bypass';
}

export class StatusShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusShapeError';
  }
}

/** Every bypass in ServerConfig, in the order the startup banner prints them. */
const BOOLEAN_BYPASSES: readonly { key: string; label: string; title: string }[] = [
  { key: 'offline', label: 'offline', title: 'The LLM is disabled. Nothing is sent to Anthropic.' },
  {
    key: 'no_artifacts',
    label: 'no artifacts',
    title: 'The export artifact pass is skipped. Exported PDFs carry no artifact record.',
  },
];

const VALUE_BYPASSES: readonly { key: string; label: string; title: string }[] = [
  { key: 'dpi', label: 'dpi', title: 'Render DPI is pinned on the command line, overriding the document.' },
  { key: 'seed', label: 'seed', title: 'The RNG seed is pinned on the command line. Output is not the document’s own.' },
];

export function deriveBadges(raw: unknown): Badge[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new StatusShapeError(`/api/status returned ${typeof raw}, not an object`);
  }
  const status = raw as Record<string, unknown>;
  const badges: Badge[] = [];

  const devBuild = status['dev_build'];
  if (typeof devBuild !== 'boolean') {
    throw new StatusShapeError(
      `/api/status is missing a boolean dev_build (got ${JSON.stringify(devBuild)})`,
    );
  }
  if (devBuild) {
    badges.push({
      id: 'dev-build',
      kind: 'dev',
      label: 'dev build',
      title: 'This build is not a clean release tag. It is a development build.',
    });
  }

  const bypasses = status['bypasses'];
  if (typeof bypasses !== 'object' || bypasses === null) {
    throw new StatusShapeError('/api/status is missing its bypasses object');
  }
  const flags = bypasses as Record<string, unknown>;

  for (const { key, label, title } of BOOLEAN_BYPASSES) {
    const value = flags[key];
    if (value === true) badges.push({ id: key, kind: 'bypass', label, title });
  }
  for (const { key, label, title } of VALUE_BYPASSES) {
    const value = flags[key];
    if (typeof value === 'number') {
      badges.push({ id: key, kind: 'bypass', label: `${label} ${value}`, title });
    }
  }
  return badges;
}

export function fetchStatus(): Promise<unknown> {
  return api<unknown>('/api/status');
}
