export function edgeScrollCanvas(
  scroller: HTMLElement,
  clientX: number,
  clientY?: number,
) {
  const bounds = scroller.getBoundingClientRect();
  const edge = 40;
  if (clientX < bounds.left + edge) {
    scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 24);
  } else if (clientX > bounds.right - edge) {
    scroller.scrollLeft += 24;
  }
  if (clientY === undefined) return;
  if (clientY < bounds.top + edge) {
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 24);
  } else if (clientY > bounds.bottom - edge) {
    scroller.scrollTop += 24;
  }
}
