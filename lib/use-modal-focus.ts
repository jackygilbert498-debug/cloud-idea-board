import { useEffect, useRef, type RefObject } from "react";

const modalStack: symbol[] = [];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

function isFocusable(element: HTMLElement) {
  return (
    element.tabIndex >= 0 &&
    element.getAttribute("aria-hidden") !== "true" &&
    !element.closest("[inert]")
  );
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isFocusable,
  );
}

function isVisibleForRestore(element: HTMLElement) {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

interface ModalFocusOptions {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  active: boolean;
}

/**
 * Keeps keyboard focus inside the top-most active modal and restores the
 * element that opened it. The stack token is stable across re-renders and is
 * removed by identity, which makes StrictMode's setup/cleanup replay safe.
 */
export function useModalFocus({
  containerRef,
  initialFocusRef,
  onClose,
  active,
}: ModalFocusOptions) {
  const tokenRef = useRef(Symbol("modal"));
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    const activeElement = document.activeElement;
    const opener = activeElement instanceof HTMLElement ? activeElement : null;
    const openerId = opener?.id || null;
    const stableOpenerId = opener?.dataset.modalFocusId || null;
    const token = tokenRef.current;

    const existingIndex = modalStack.lastIndexOf(token);
    if (existingIndex >= 0) modalStack.splice(existingIndex, 1);
    modalStack.push(token);

    const isTopModal = () => modalStack.at(-1) === token;
    const focusInitial = () => {
      const target =
        initialFocusRef.current ?? getFocusableElements(container)[0] ?? container;
      target.focus();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal()) return;

      if (event.key === "Escape") {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const current = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!container.contains(current) || (event.shiftKey && current === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopModal()) return;
      if (!(event.target instanceof Node) || container.contains(event.target)) return;
      focusInitial();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    focusInitial();

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);

      const equivalent = stableOpenerId
        ? Array.from(document.querySelectorAll<HTMLElement>("[data-modal-focus-id]"))
          .find((candidate) => candidate.dataset.modalFocusId === stableOpenerId
            && candidate !== opener
            && isVisibleForRestore(candidate))
        : null;
      const restoreTarget = opener?.isConnected === true && isVisibleForRestore(opener)
        ? opener
        : equivalent ?? (openerId ? document.getElementById(openerId) : null);
      restoreTarget?.focus();
    };
  }, [active, containerRef, initialFocusRef]);
}
