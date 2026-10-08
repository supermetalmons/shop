import * as THREE from 'three';
import { MI_NOTE_CARD_HEIGHT, MI_NOTE_CARD_WIDTH } from './miNotePackModel';

export function createMiNoteCardGeometry() {
  const width = MI_NOTE_CARD_WIDTH;
  const height = MI_NOTE_CARD_HEIGHT;
  const radius = width * 0.0455;
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  const geometry = new THREE.ShapeGeometry(shape, 12);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let index = 0; index < uv.count; index += 1) {
    uv.setXY(index, position.getX(index) / width + 0.5, position.getY(index) / height + 0.5);
  }
  return geometry;
}
