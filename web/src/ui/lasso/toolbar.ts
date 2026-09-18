/**
 * The selection toolbar. Placement rules are from the verified design pass (§B.4) and
 * every one of them exists because the obvious implementation gets it wrong.
 *
 *   - centred on the lasso bbox, 12px above
 *   - flips below when it would collide with the top bar
 *   - clamped horizontally inside the canvas
 *   - NEVER overlaps the selected pixels — the whole point is to look at them
 *   - dark scrim in both themes, so it stays legible over bright paper
 *   - 110ms ease-out in, 80ms out
 *
 * Four pills: Ask · Edit · Restyle · Re-roll. On a multi-block selection **Edit
 * disables with a reason** and the other three stay live.
 */

export type ToolbarAction = 'ask' | 'edit' | 'restyle' | 'reroll';

export interface ToolbarRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacementInput {
  /** The selection's bounding box in viewport pixels. */
  readonly selection: ToolbarRect;
  readonly toolbar: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  /** Height of the fixed top bar the toolbar must not collide with. */
  readonly topBarH: number;
  readonly gap?: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly below: boolean;
}

/**
 * Pure, so it is testable without a DOM. Every rule above is a branch here and each
 * has a test.
 */
export function placeToolbar(input: PlacementInput): Placement {
  const gap = input.gap ?? 12;
  const { selection, toolbar, viewport, topBarH } = input;

  const centred = selection.left + selection.width / 2 - toolbar.width / 2;
  // Clamped horizontally inside the canvas, with the same gap used as the edge inset.
  const left = Math.max(gap, Math.min(centred, viewport.width - toolbar.width - gap));

  const above = selection.top - gap - toolbar.height;
  // Flip below only when sitting above would collide with the top bar. Note this
  // compares against the BAR, not against 0: a toolbar tucked under a fixed bar is
  // invisible, which reads as the toolbar failing to appear at all.
  const collidesWithTopBar = above < topBarH + gap;

  if (!collidesWithTopBar) {
    return { left, top: above, below: false };
  }

  // Below the selection, never overlapping it.
  const below = selection.top + selection.height + gap;
  const maxTop = viewport.height - toolbar.height - gap;
  return { left, top: Math.min(below, Math.max(topBarH + gap, maxTop)), below: true };
}

export interface ToolbarState {
  readonly actions: readonly { action: ToolbarAction; enabled: boolean; reason?: string }[];
}

/** Multi-select disables Edit, with a reason, and leaves the rest live. */
export function toolbarState(selectedCount: number): ToolbarState {
  const multi = selectedCount > 1;
  return {
    actions: [
      { action: 'ask', enabled: selectedCount > 0 },
      {
        action: 'edit',
        enabled: selectedCount === 1,
        ...(multi ? { reason: 'Edit works on one block at a time' } : {}),
      },
      { action: 'restyle', enabled: selectedCount > 0 },
      { action: 'reroll', enabled: selectedCount > 0 },
    ],
  };
}
