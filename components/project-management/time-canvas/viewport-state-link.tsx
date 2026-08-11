"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

export const TIME_CANVAS_VIEWPORT_STATE_EVENT = "time-canvas:viewport-state";

export function ViewportStateLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [renderedHref, setRenderedHref] = useState(href);

  useEffect(() => {
    const updateHref = () => {
      setRenderedHref(
        mergeViewportState(
          href,
          new URL(window.location.href).searchParams,
        ),
      );
    };
    updateHref();
    window.addEventListener("popstate", updateHref);
    window.addEventListener(TIME_CANVAS_VIEWPORT_STATE_EVENT, updateHref);
    return () => {
      window.removeEventListener("popstate", updateHref);
      window.removeEventListener(TIME_CANVAS_VIEWPORT_STATE_EVENT, updateHref);
    };
  }, [href]);

  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const current = new URL(window.location.href);
    const target = new URL(renderedHref, current);
    if (target.origin !== current.origin) return;
    for (const key of ["center", "scale"]) {
      const value = current.searchParams.get(key);
      if (value) target.searchParams.set(key, value);
    }
    event.preventDefault();
    router.push(`${target.pathname}${target.search}${target.hash}`);
  }

  return (
    <Link href={renderedHref} className={className} onClick={navigate}>
      {children}
    </Link>
  );
}

function mergeViewportState(
  href: string,
  current: Pick<URLSearchParams, "get">,
) {
  const target = new URL(href, "http://viewport-state.local");
  for (const key of ["center", "scale"]) {
    const value = current.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return `${target.pathname}${target.search}${target.hash}`;
}
