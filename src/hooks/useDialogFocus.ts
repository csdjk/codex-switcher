import { useEffect, useRef } from "react";

/** Trap focus only while the dialog is open; preserve forms when theme/language changes. */
export function useDialogFocus(open: boolean, onClose: () => void, fallbackSelector?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
    )).filter(element => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
    const timer = window.setTimeout(() => {
      const preferred = dialog.querySelector<HTMLElement>('input:not([readonly]):not(:disabled), select:not(:disabled)');
      (preferred ?? focusable()[0] ?? dialog).focus({ preventScroll: true });
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        if (!elements.length) { event.preventDefault(); dialog.focus(); return; }
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      dialog.removeEventListener("keydown", onKeyDown);
      const target = previous?.isConnected && previous !== document.body ? previous
        : fallbackSelector ? document.querySelector<HTMLElement>(fallbackSelector) : null;
      target?.focus({ preventScroll: true });
    };
  }, [open, fallbackSelector]);
  return ref;
}
