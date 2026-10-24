import { useEffect, useRef } from "react";

const dialogs: HTMLElement[] = [];

/** Keep nested screenshot viewers above the editor in the keyboard focus order. */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogs.push(root);
    // Focus the dialog, not an input: opening it must not summon a phone keyboard.
    root.focus({ preventScroll: true });

    const keydown = (event: KeyboardEvent) => {
      if (dialogs[dialogs.length - 1] !== root || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const targets = Array.from(root.querySelectorAll<HTMLElement>(
        'button, a[href], input, textarea, select, [tabindex]',
      )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled, [inert], [hidden]") && element.getClientRects().length > 0);
      const current = targets.indexOf(document.activeElement as HTMLElement);
      if (targets.length === 0 || current < 0 || (event.shiftKey ? current === 0 : current === targets.length - 1)) {
        event.preventDefault();
        (targets[event.shiftKey ? targets.length - 1 : 0] ?? root).focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      const index = dialogs.indexOf(root);
      if (index >= 0) dialogs.splice(index, 1);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  return ref;
}
