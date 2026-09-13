"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

export function useMeetingFieldErrors(formRef: RefObject<HTMLFormElement | null>, pending: boolean, initialErrors: Record<string, string[]> = {}) {
  const [fieldErrors, setFieldErrors] = useState(initialErrors);
  const focusRequested = useRef(false);
  useEffect(() => {
    if (pending || !focusRequested.current) return;
    const frame = requestAnimationFrame(() => {
      focusRequested.current = false;
      formRef.current?.querySelector<HTMLElement>('input[aria-invalid="true"], textarea[aria-invalid="true"], button[aria-invalid="true"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [fieldErrors, pending, formRef]);
  function showErrors(errors: Record<string, string[]>) {
    focusRequested.current = true;
    setFieldErrors(errors);
  }
  return { fieldErrors, setFieldErrors, showErrors };
}
