export type PackPointerEvent = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary' | 'button' | 'clientX' | 'clientY' | 'preventDefault'>;
type PackClickEvent = Pick<MouseEvent, 'detail' | 'preventDefault'>;

type PointerMovement = {
  startX: number;
  startY: number;
  deltaX: number;
  deltaY: number;
  moved: boolean;
};

type InputOptions = {
  onStart?: (event: PackPointerEvent) => boolean | void;
  onMove?: (event: PackPointerEvent, movement: PointerMovement) => void;
  onEnd?: (event: PackPointerEvent, movement: PointerMovement & { cancelled: boolean }) => void;
};

export function createMiNoteCardInput(activate: (event?: PackPointerEvent) => void, options: InputOptions = {}) {
  let pointer: { id: number; startX: number; startY: number; moved: boolean; lastEvent: PackPointerEvent } | null = null;

  function movement(event: PackPointerEvent): PointerMovement | null {
    if (!pointer || pointer.id !== event.pointerId) return null;
    const deltaX = event.clientX - pointer.startX;
    const deltaY = event.clientY - pointer.startY;
    pointer.moved ||= Math.hypot(deltaX, deltaY) > 5;
    pointer.lastEvent = event;
    return { startX: pointer.startX, startY: pointer.startY, deltaX, deltaY, moved: pointer.moved };
  }

  function cancel() {
    if (!pointer) return;
    const event = pointer.lastEvent;
    const position = movement(event)!;
    pointer = null;
    options.onEnd?.(event, { ...position, cancelled: true });
  }

  return {
    onPointerDown(event: PackPointerEvent) {
      if (pointer || !event.isPrimary || event.button !== 0 || options.onStart?.(event) === false) return;
      pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, lastEvent: event };
    },
    onPointerMove(event: PackPointerEvent) {
      if (!event.isPrimary) return;
      const position = movement(event);
      if (position) options.onMove?.(event, position);
    },
    onPointerUp(event: PackPointerEvent) {
      if (!event.isPrimary || event.button !== 0) return;
      const position = movement(event);
      if (!position) return;
      event.preventDefault();
      const activePointer = pointer;
      options.onMove?.(event, position);
      if (pointer !== activePointer) return;
      pointer = null;
      options.onEnd?.(event, { ...position, cancelled: false });
      if (!position.moved) activate(event);
    },
    onPointerCancel(event: PackPointerEvent) {
      if (pointer?.id === event.pointerId) cancel();
    },
    onLostPointerCapture(event: PackPointerEvent) {
      if (pointer?.id === event.pointerId) cancel();
    },
    onClick(event: PackClickEvent) {
      if (event.detail === 0) activate();
      else event.preventDefault();
    },
    cancel,
  };
}
