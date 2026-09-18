/**
 * The reference hand that ships with the app. Acceptance row 9.
 *
 * Row 9 asks that the app render a page within 60 s of first launch with ZERO SETUP, in
 * a hand that is clearly labelled as not being the user's own. That is what this file is:
 * a font that is in the repository, served from the bundle, loaded with one fetch, and
 * described well enough that the UI can say whose handwriting it is not.
 *
 * WHY CAVEAT. The M0 spike compared three OFL hands and found Caveat hides the
 * outline-repetition tell best — its letterforms vary enough between neighbouring shapes
 * that six affine variants are enough to stop a paragraph reading as a font. It also has
 * complete Latin-1, the punctuation an assignment needs, and the maths marks that matter
 * (times, divide, plus-minus, <=, >=, !=, approx, degree, micro).
 *
 * LICENCE. SIL Open Font License 1.1. `web/public/fonts/reference/OFL.txt` ships beside
 * the font, as the licence requires. This is NOT the user's handwriting and never becomes
 * it: invariant I9 keeps the tracing sheet, the extracted profile and any personal font
 * out of the repository and off the wire, and the repository being public is exactly why
 * every fixture in it uses this hand instead.
 */

/** What the UI needs in order to label the hand honestly. */
export interface ReferenceHandInfo {
  /** The canonical profile id the providers report. */
  readonly profileId: string;
  /** Shown to the user. Says plainly that this is not their handwriting. */
  readonly label: string;
  readonly family: string;
  readonly licence: string;
  readonly licencePath: string;
  readonly fontPath: string;
}

export const REFERENCE_HAND: ReferenceHandInfo = {
  profileId: 'reference:caveat-regular',
  label: 'Caveat (reference hand — not your handwriting)',
  family: 'Caveat Regular',
  licence: 'SIL Open Font License 1.1',
  licencePath: 'fonts/reference/OFL.txt',
  fontPath: 'fonts/reference/Caveat-Regular.ttf',
};

/**
 * The profile ids that resolve to the reference hand.
 *
 * `'reference'` is the kernel's default when a document names no hand
 * (kernel.ts: `style.hand?.profile ?? 'reference'`), so it must be accepted verbatim or
 * a fresh launch cannot render anything at all.
 */
export const REFERENCE_ALIASES: readonly string[] = [
  'reference',
  'default',
  REFERENCE_HAND.profileId,
];

export function isReferenceProfile(profileId: string): boolean {
  return REFERENCE_ALIASES.includes(profileId);
}
