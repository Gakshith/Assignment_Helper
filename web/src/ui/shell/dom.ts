/** A small typed element builder. No innerHTML for anything data-driven. */

export interface ElSpec {
  readonly class?: string;
  readonly id?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly Node[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElSpec = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (spec.class !== undefined) node.className = spec.class;
  if (spec.id !== undefined) node.id = spec.id;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.title !== undefined) node.title = spec.title;
  if (spec.attrs) {
    for (const [name, value] of Object.entries(spec.attrs)) node.setAttribute(name, value);
  }
  if (spec.children) node.append(...spec.children);
  return node;
}

/** Inline SVG from a literal string. Only ever called with constants in this file's
 *  callers -- never with anything that came off the wire. */
export function svg(markup: string, className: string): SVGElement {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  const first = holder.firstElementChild;
  if (!(first instanceof SVGElement)) throw new Error('svg(): the markup is not an <svg>');
  first.setAttribute('class', className);
  first.setAttribute('aria-hidden', 'true');
  return first;
}
