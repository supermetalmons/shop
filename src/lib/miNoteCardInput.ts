type PackPointerEvent = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary' | 'button' | 'clientX' | 'clientY' | 'preventDefault'>;
type PackClickEvent = Pick<MouseEvent, 'detail' | 'preventDefault'>;

export function createMiNoteCardInput(activate: () => void) {
  let pointer: { id: number; x: number; y: number } | null = null;
  let suppressClick = false;
  const moved = (event: PackPointerEvent) => pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 12;

  return {
    onPointerDown(event: PackPointerEvent) {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = event.pointerType !== 'mouse';
      pointer = suppressClick ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    },
    onPointerMove(event: PackPointerEvent) {
      if (pointer?.id === event.pointerId && moved(event)) pointer = null;
    },
    onPointerUp(event: PackPointerEvent) {
      if (!event.isPrimary || event.button !== 0 || event.pointerType === 'mouse') return;
      event.preventDefault();
      const complete = pointer?.id === event.pointerId && !moved(event);
      pointer = null;
      if (complete) activate();
    },
    onPointerCancel(event: PackPointerEvent) {
      if (pointer?.id === event.pointerId) pointer = null;
    },
    onClick(event: PackClickEvent) {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      activate();
    },
  };
}
