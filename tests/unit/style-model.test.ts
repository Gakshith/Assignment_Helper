/**
 * The style write path's one real hazard: `SetStyle` REPLACES the whole style, so a
 * partial body silently resets every field it leaves out. These tests hold the line.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE,
  resolveStyle,
  sameStyle,
  toWire,
  withHand,
  withPaper,
} from '@/ui/panels/style-model';

describe('resolveStyle', () => {
  it('fills an absent style with the schema defaults', () => {
    expect(resolveStyle(undefined)).toEqual(DEFAULT_STYLE);
  });

  it('keeps every field the server sent', () => {
    const resolved = resolveStyle({
      paper: { kind: 'grid', page_size: 'a4', tint: '#FFFFFF' },
      hand: { neatness: 0.8, overrides: { jitter: 0.25 } },
      preview_dpi: 200,
    });
    expect(resolved.paper.kind).toBe('grid');
    expect(resolved.paper.page_size).toBe('a4');
    expect(resolved.paper.tint).toBe('#FFFFFF');
    expect(resolved.hand.neatness).toBe(0.8);
    expect(resolved.hand.overrides).toEqual({ jitter: 0.25 });
    expect(resolved.preview_dpi).toBe(200);
    // Everything not sent falls back to the schema default, not to nothing.
    expect(resolved.paper.ruling).toBe(DEFAULT_STYLE.paper.ruling);
    expect(resolved.export_dpi).toBe(DEFAULT_STYLE.export_dpi);
  });

  it('drops a non-numeric override rather than sending it to a float field', () => {
    const resolved = resolveStyle({
      hand: { overrides: { jitter: 0.5, broken: Number.NaN } },
    });
    expect(resolved.hand.overrides).toEqual({ jitter: 0.5 });
  });
});

describe('toWire', () => {
  it('always carries every field, because SetStyle replaces rather than merges', () => {
    const wire = toWire(DEFAULT_STYLE);
    expect(Object.keys(wire).sort()).toEqual(
      ['export_dpi', 'hand', 'margins_mm', 'paper', 'preview_dpi'].sort(),
    );
    expect(Object.keys(wire.paper ?? {}).sort()).toEqual(
      ['aging', 'grain', 'kind', 'margin_rule_colour', 'page_size', 'rule_colour', 'ruling', 'tint'].sort(),
    );
    expect(Object.keys(wire.hand ?? {}).sort()).toEqual(
      ['ink_colour', 'neatness', 'overrides', 'profile', 'size_mm', 'slant_deg'].sort(),
    );
  });

  it('survives a round trip through the server unchanged', () => {
    const edited = withPaper(withHand(DEFAULT_STYLE, { neatness: 0.13 }), { kind: 'rough' });
    expect(resolveStyle(toWire(edited))).toEqual(edited);
  });

  it('changing one field leaves every other field alone', () => {
    const before = toWire(DEFAULT_STYLE);
    const after = toWire(withHand(DEFAULT_STYLE, { ink_colour: '#123456' }));
    expect(after.paper).toEqual(before.paper);
    expect(after.margins_mm).toEqual(before.margins_mm);
    expect(after.export_dpi).toBe(before.export_dpi);
    expect(after.hand?.ink_colour).toBe('#123456');
  });

  it('copies the overrides map instead of sharing it', () => {
    const style = withHand(DEFAULT_STYLE, { overrides: { jitter: 0.2 } });
    const wire = toWire(style);
    expect(wire.hand?.overrides).not.toBe(style.hand.overrides);
    expect(wire.hand?.overrides).toEqual({ jitter: 0.2 });
  });
});

describe('sameStyle', () => {
  it('is true for an unchanged style and false for a changed one', () => {
    expect(sameStyle(DEFAULT_STYLE, resolveStyle(toWire(DEFAULT_STYLE)))).toBe(true);
    expect(sameStyle(DEFAULT_STYLE, withHand(DEFAULT_STYLE, { neatness: 0.51 }))).toBe(false);
  });
});
