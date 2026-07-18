function findVisibleInventoryMediaElement(root: ParentNode): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>('.inventory__media > :not([hidden])') ||
    root.querySelector<HTMLElement>('.inventory__media') ||
    root.querySelector<HTMLElement>('.inventory__image')
  );
}

export function getInventoryRevealRect(target: HTMLElement): DOMRect {
  return (findVisibleInventoryMediaElement(target) || target).getBoundingClientRect();
}
