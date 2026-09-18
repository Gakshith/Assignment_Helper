/**
 * Invariant I15: you can never be unknowingly in a bypass.
 *
 * This is the UI third of the dev-build guard. The rule under test is not "badges
 * render" but "an active bypass is ALWAYS badged, and an unreadable status is never
 * read as an all-clear".
 */

import { describe, expect, it } from 'vitest';
import { StatusShapeError, deriveBadges } from '@/ui/shell/status';

/** The exact body assignment_helper/app.py's /api/status returns. */
function status(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.1.0',
    dev_build: false,
    port: 7420,
    bypasses: { offline: false, no_artifacts: false, dpi: null, seed: null },
    routers: {},
    ...over,
  };
}

describe('deriveBadges', () => {
  it('shows nothing on a clean release build with no bypasses', () => {
    expect(deriveBadges(status())).toEqual([]);
  });

  it('badges a dev build permanently', () => {
    const badges = deriveBadges(status({ dev_build: true }));
    expect(badges).toHaveLength(1);
    expect(badges[0]?.id).toBe('dev-build');
    expect(badges[0]?.kind).toBe('dev');
    expect(badges[0]?.label).toBe('dev build');
  });

  it('badges every boolean bypass that is on', () => {
    const badges = deriveBadges(status({ bypasses: { offline: true, no_artifacts: true, dpi: null, seed: null } }));
    expect(badges.map((b) => b.id)).toEqual(['offline', 'no_artifacts']);
  });

  it('badges a pinned dpi or seed with its value, since 0 is a real pin', () => {
    const badges = deriveBadges(status({ bypasses: { offline: false, no_artifacts: false, dpi: 300, seed: 0 } }));
    expect(badges.map((b) => b.label)).toEqual(['dpi 300', 'seed 0']);
  });

  it('badges all of them at once', () => {
    const badges = deriveBadges(
      status({ dev_build: true, bypasses: { offline: true, no_artifacts: true, dpi: 96, seed: 7 } }),
    );
    expect(badges.map((b) => b.id)).toEqual(['dev-build', 'offline', 'no_artifacts', 'dpi', 'seed']);
  });

  it('gives every badge a stable id and a title that says what it means', () => {
    const badges = deriveBadges(
      status({ dev_build: true, bypasses: { offline: true, no_artifacts: true, dpi: 96, seed: 7 } }),
    );
    expect(new Set(badges.map((b) => b.id)).size).toBe(badges.length);
    for (const badge of badges) expect(badge.title.length).toBeGreaterThan(20);
  });

  it('refuses a malformed status instead of reporting an all-clear', () => {
    expect(() => deriveBadges(null)).toThrow(StatusShapeError);
    expect(() => deriveBadges('ok')).toThrow(StatusShapeError);
    expect(() => deriveBadges({ dev_build: true })).toThrow(StatusShapeError);
    expect(() => deriveBadges({ bypasses: {} })).toThrow(StatusShapeError);
    // A missing dev_build is the dangerous one: defaulting it to false would hide
    // exactly the state I15 exists to surface.
    expect(() => deriveBadges(status({ dev_build: undefined }))).toThrow(StatusShapeError);
  });

  it('ignores a bypass key it does not know rather than throwing', () => {
    const badges = deriveBadges(
      status({ bypasses: { offline: false, no_artifacts: false, dpi: null, seed: null, future: true } }),
    );
    expect(badges).toEqual([]);
  });
});
