// OWNER: the layout strand.
import type { LayoutEngine } from '../../app/contracts';
import { layoutDocument } from './engine';

export const layoutEngine: LayoutEngine = {
  name: 'layout',
  layout: layoutDocument,
};

export { layoutDocument, FIT_SCALE_FLOOR } from './engine';
