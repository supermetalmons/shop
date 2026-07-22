import { isDropFamily } from '../config/deployment';

export type DropSizeGuideRow = {
  size: string;
  bodyLength: string;
  chestWidth: string;
  sleeveLength: string;
};

export type DropSizeGuide = {
  selectionAriaLabel: string;
  dialogAriaLabel: string;
  rows: readonly DropSizeGuideRow[];
};

const LITTLE_SWAG_HOODIES_SIZE_GUIDE: DropSizeGuide = {
  selectionAriaLabel: 'Hoodie size',
  dialogAriaLabel: 'Hoodie sizing',
  rows: [
    { size: 'L', bodyLength: '28 1/2', chestWidth: '25 1/2', sleeveLength: '24 3/4' },
    { size: 'XL', bodyLength: '29 1/2', chestWidth: '27 1/2', sleeveLength: '25 1/4' },
    { size: '2XL', bodyLength: '30 1/2', chestWidth: '29 1/2', sleeveLength: '26' },
  ],
};

const DRIFELLA_SHIRT_SIZE_GUIDE: DropSizeGuide = {
  selectionAriaLabel: 'Shirt size',
  dialogAriaLabel: 'Shirt sizing',
  rows: [
    { size: 'L', bodyLength: '27 3/8', chestWidth: '22 7/8', sleeveLength: '9' },
    { size: 'XL', bodyLength: '28 3/8', chestWidth: '24 7/8', sleeveLength: '9 1/4' },
    { size: '2XL', bodyLength: '29 3/8', chestWidth: '26 7/8', sleeveLength: '9 1/2' },
  ],
};

export function resolveDropSizeGuide(dropId: string | undefined): DropSizeGuide | null {
  if (isDropFamily(dropId, 'little_swag_hoodies')) return LITTLE_SWAG_HOODIES_SIZE_GUIDE;
  if (isDropFamily(dropId, 'drifella_shirt')) return DRIFELLA_SHIRT_SIZE_GUIDE;
  return null;
}
