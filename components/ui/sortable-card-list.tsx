"use client";

/* eslint-disable react-hooks/refs -- This low-level drag list keeps a DOM node registry for pointer hit-testing. */

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type SortableCardListRenderArgs = {
  index: number;
  isDragging: boolean;
  dragHandleProps: {
    "data-sortable-grip": true;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    style: CSSProperties;
  };
  moveItem: (toIndex: number) => void;
};

type SortableCardListProps<T> = {
  items: T[];
  getKey: (item: T) => string;
  getItemLabel?: (item: T, index: number) => string;
  onReorder: (items: T[], movedItem: T, fromIndex: number, toIndex: number) => void;
  renderItem: (item: T, args: SortableCardListRenderArgs) => ReactNode;
  ariaLabel: string;
  className?: string;
  itemClassName?:
    | string
    | ((item: T, index: number, isDragging: boolean) => string | undefined);
  itemTestId?: string;
};

type DragState = {
  key: string;
  pointerId: number;
  pointerX: number;
  pointerY: number;
  grabOffsetY: number;
};

type PointerPosition = {
  x: number;
  y: number;
};

export function SortableCardList<T>({
  items,
  getKey,
  getItemLabel,
  onReorder,
  renderItem,
  ariaLabel,
  className,
  itemClassName,
  itemTestId,
}: SortableCardListProps<T>) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const previousRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const itemsRef = useRef(items);
  const dragRef = useRef<DragState | null>(null);
  const pointerPositionRef = useRef<PointerPosition | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);

  const capturePositions = useCallback(() => {
    if (prefersReducedMotion()) {
      previousRectsRef.current = new Map();
      return;
    }

    previousRectsRef.current = new Map(
      itemsRef.current.flatMap((item) => {
        const key = getKey(item);
        const element = itemRefs.current.get(key);
        return element ? [[key, element.getBoundingClientRect()]] : [];
      }),
    );
  }, [getKey]);

  const animateFromPreviousRects = useCallback((skipKey?: string) => {
    const previousRects = previousRectsRef.current;
    if (previousRects.size === 0 || prefersReducedMotion()) {
      previousRectsRef.current = new Map();
      return;
    }

    previousRectsRef.current = new Map();
    itemsRef.current.forEach((item) => {
      const key = getKey(item);
      if (key === skipKey) return;
      const element = itemRefs.current.get(key);
      const previousRect = previousRects.get(key);
      if (!element || !previousRect) return;

      element.getAnimations().forEach((animation) => animation.cancel());
      const nextRect = element.getBoundingClientRect();
      const translateX = previousRect.left - nextRect.left;
      const translateY = previousRect.top - nextRect.top;
      if (Math.abs(translateX) < 1 && Math.abs(translateY) < 1) return;

      element.animate(
        [
          { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        {
          duration: 180,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        },
      );
    });
  }, [getKey]);

  const announceMove = useCallback((item: T, toIndex: number) => {
    const label = getItemLabel?.(item, toIndex) ?? "当前项目";
    setAnnouncement(`「${label}」已移动到第 ${toIndex + 1} 位`);
  }, [getItemLabel]);

  const applyDraggedTransform = useCallback((nextDrag = dragRef.current) => {
    if (!nextDrag) return;
    const element = itemRefs.current.get(nextDrag.key);
    if (!element) return;
    const previousTransform = element.style.transform;
    element.style.transform = "";
    const rect = element.getBoundingClientRect();
    element.style.transform = previousTransform;
    const translateY = nextDrag.pointerY - nextDrag.grabOffsetY - rect.top;
    element.style.transform = `translate3d(0, ${translateY}px, 0)`;
    element.style.zIndex = "30";
  }, []);

  const dropDraggedItem = useCallback((currentDrag: DragState) => {
    const element = itemRefs.current.get(currentDrag.key);
    if (!element) return;
    const currentTransform = element.style.transform || "translate3d(0, 0, 0)";
    element.style.transform = "";
    element.style.zIndex = "";
    if (prefersReducedMotion()) return;
    element.animate(
      [
        {
          transform: currentTransform,
          boxShadow: "0 18px 40px rgb(15 23 42 / 0.16)",
        },
        {
          transform: "translate3d(0, 0, 0)",
          boxShadow: "0 0 0 rgb(15 23 42 / 0)",
        },
      ],
      {
        duration: 180,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      },
    );
  }, []);

  const getOrderForPointer = useCallback((currentDrag: DragState) => {
    const currentItems = itemsRef.current;
    const fromIndex = currentItems.findIndex(
      (item) => getKey(item) === currentDrag.key,
    );
    const movedItem = currentItems[fromIndex];
    if (!movedItem || fromIndex < 0) return null;

    const remainingItems = currentItems.filter(
      (item) => getKey(item) !== currentDrag.key,
    );
    let insertIndex = 0;
    remainingItems.forEach((item) => {
      const element = itemRefs.current.get(getKey(item));
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (currentDrag.pointerY > rect.top + rect.height / 2) {
        insertIndex += 1;
      }
    });

    const nextItems = [...remainingItems];
    nextItems.splice(insertIndex, 0, movedItem);
    const toIndex = nextItems.findIndex(
      (item) => getKey(item) === currentDrag.key,
    );
    if (toIndex === fromIndex) return null;
    return { items: nextItems, movedItem, fromIndex, toIndex };
  }, [getKey]);

  const reorderForDrag = useCallback((currentDrag: DragState) => {
    const nextOrder = getOrderForPointer(currentDrag);
    if (!nextOrder) return;

    capturePositions();
    onReorder(
      nextOrder.items,
      nextOrder.movedItem,
      nextOrder.fromIndex,
      nextOrder.toIndex,
    );
    announceMove(nextOrder.movedItem, nextOrder.toIndex);
  }, [announceMove, capturePositions, getOrderForPointer, onReorder]);

  const stopAutoScrollLoop = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const startAutoScrollLoop = useCallback(() => {
    if (autoScrollFrameRef.current !== null) return;

    function tick() {
      const currentDrag = dragRef.current;
      const pointerPosition = pointerPositionRef.current;
      if (!currentDrag || !pointerPosition) {
        autoScrollFrameRef.current = null;
        return;
      }

      autoScrollNearEdges(pointerPosition);
      applyDraggedTransform(currentDrag);
      autoScrollFrameRef.current = window.requestAnimationFrame(tick);
    }

    autoScrollFrameRef.current = window.requestAnimationFrame(tick);
  }, [applyDraggedTransform]);

  const handleDragStart = useCallback((
    item: T,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    const key = getKey(item);
    const element = itemRefs.current.get(key);
    if (!element) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    element.getAnimations().forEach((animation) => animation.cancel());
    const rect = element.getBoundingClientRect();
    const nextDrag = {
      key,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      grabOffsetY: event.clientY - rect.top,
    };
    dragRef.current = nextDrag;
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    setDrag(nextDrag);
    applyDraggedTransform(nextDrag);
    startAutoScrollLoop();
  }, [applyDraggedTransform, getKey, startAutoScrollLoop]);

  const moveItem = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || toIndex < 0 || toIndex >= itemsRef.current.length) {
      return;
    }
    const nextItems = [...itemsRef.current];
    const [movedItem] = nextItems.splice(fromIndex, 1);
    if (!movedItem) return;
    nextItems.splice(toIndex, 0, movedItem);
    capturePositions();
    onReorder(nextItems, movedItem, fromIndex, toIndex);
    announceMove(movedItem, toIndex);
    window.setTimeout(() => {
      itemRefs.current
        .get(getKey(movedItem))
        ?.querySelector<HTMLElement>("[data-sortable-grip]")
        ?.focus();
    }, 0);
  }, [announceMove, capturePositions, getKey, onReorder]);

  const setItemRef = useCallback((key: string) => {
    return (element: HTMLLIElement | null) => {
      if (element) {
        itemRefs.current.set(key, element);
      } else {
        itemRefs.current.delete(key);
      }
    };
  }, []);

  useLayoutEffect(() => {
    itemsRef.current = items;
    animateFromPreviousRects(dragRef.current?.key);
    applyDraggedTransform();
  }, [animateFromPreviousRects, applyDraggedTransform, items]);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  const activePointerId = drag?.pointerId ?? null;

  useEffect(() => {
    if (activePointerId === null) return;

    function handlePointerMove(event: PointerEvent) {
      const currentDrag = dragRef.current;
      if (
        !currentDrag ||
        event.pointerId !== activePointerId ||
        event.pointerId !== currentDrag.pointerId
      ) {
        return;
      }
      event.preventDefault();

      const nextDrag = {
        ...currentDrag,
        pointerX: event.clientX,
        pointerY: event.clientY,
      };
      dragRef.current = nextDrag;
      pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      setDrag(nextDrag);
      applyDraggedTransform(nextDrag);
      reorderForDrag(nextDrag);
      startAutoScrollLoop();
    }

    function handlePointerUp(event: PointerEvent) {
      const currentDrag = dragRef.current;
      if (
        !currentDrag ||
        event.pointerId !== activePointerId ||
        event.pointerId !== currentDrag.pointerId
      ) {
        return;
      }
      dropDraggedItem(currentDrag);
      dragRef.current = null;
      pointerPositionRef.current = null;
      setDrag(null);
      stopAutoScrollLoop();
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      stopAutoScrollLoop();
    };
  }, [
    activePointerId,
    applyDraggedTransform,
    dropDraggedItem,
    reorderForDrag,
    startAutoScrollLoop,
    stopAutoScrollLoop,
  ]);

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <ol className={className} aria-label={ariaLabel}>
        {items.map((item, index) => {
          const key = getKey(item);
          const isDragging = drag?.key === key;
          const resolvedItemClassName =
            typeof itemClassName === "function"
              ? itemClassName(item, index, isDragging)
              : itemClassName;

          return (
            <li
              key={key}
              ref={setItemRef(key)}
              data-testid={itemTestId}
              className={cn(
                "relative will-change-transform",
                isDragging && "select-none shadow-lg",
                resolvedItemClassName,
              )}
            >
              {renderItem(item, {
                index,
                isDragging,
                dragHandleProps: {
                  "data-sortable-grip": true,
                  onPointerDown: (event) => handleDragStart(item, event),
                  style: { touchAction: "none" },
                },
                moveItem: (toIndex) => moveItem(index, toIndex),
              })}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function autoScrollNearEdges(pointer: PointerPosition) {
  const margin = 72;
  const maxSpeed = 18;
  const viewportHeight = window.innerHeight;

  if (pointer.y < margin) {
    window.scrollBy({ top: -Math.min(maxSpeed, margin - pointer.y), behavior: "auto" });
    return;
  }
  if (pointer.y > viewportHeight - margin) {
    window.scrollBy({
      top: Math.min(maxSpeed, pointer.y - (viewportHeight - margin)),
      behavior: "auto",
    });
    return;
  }

  const scrollable = document
    .elementsFromPoint(pointer.x, pointer.y)
    .find((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      return (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight
      );
    });

  if (!(scrollable instanceof HTMLElement)) return;
  const rect = scrollable.getBoundingClientRect();
  if (pointer.y < rect.top + margin) {
    scrollable.scrollBy({ top: -Math.min(maxSpeed, rect.top + margin - pointer.y) });
  } else if (pointer.y > rect.bottom - margin) {
    scrollable.scrollBy({
      top: Math.min(maxSpeed, pointer.y - (rect.bottom - margin)),
    });
  }
}
