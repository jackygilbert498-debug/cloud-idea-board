// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useDialogFocus } from "@/lib/use-dialog-focus";

function Dialog({ name, onClose, children }: { name: string; onClose: () => void; children?: React.ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(onClose);
  return <div ref={ref} role="dialog" aria-label={name} tabIndex={-1}>
    <button>First</button><textarea aria-label="Text" /><button disabled>Disabled</button>
    <button hidden>Hidden</button>{children}<button>Last</button>
  </div>;
}

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let trigger: HTMLButtonElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no layout; emulate visibility only, not keyboard or focus behavior.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    const rects = this.closest("[hidden]") ? [] : [new DOMRect(0, 0, 100, 44)];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
  });
  trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  trigger.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("opening a dialog does not focus a text input; unmount restores the trigger", async () => {
  await act(async () => root.render(<Dialog name="Editor" onClose={() => undefined} />));
  expect(document.activeElement?.getAttribute("role")).toBe("dialog");
  await act(async () => root.render(null));
  expect(document.activeElement).toBe(trigger);
});

test("Tab wraps in both directions without reaching hidden or disabled controls", async () => {
  await act(async () => root.render(<Dialog name="Editor" onClose={() => undefined} />));
  const buttons = container.querySelectorAll("button");
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  last.focus();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(first);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(last);
});

test("Escape closes only the screenshot viewer and returns focus to its editor opener", async () => {
  function Nested() {
    const [open, setOpen] = useState(true);
    const [viewer, setViewer] = useState(false);
    return <>{open && <Dialog name="Editor" onClose={() => setOpen(false)}>
      <button id="open-viewer" onClick={() => setViewer(true)}>View image</button>
    </Dialog>}{viewer && <Dialog name="Viewer" onClose={() => setViewer(false)} />}</>;
  }
  await act(async () => root.render(<Nested />));
  const opener = container.querySelector<HTMLButtonElement>("#open-viewer")!;
  opener.focus();
  await act(async () => opener.click());
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Viewer");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.activeElement).toBe(opener);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  expect(document.activeElement).toBe(trigger);
});

test("rerenders preserve active input and use the latest close callback; composition is ignored", async () => {
  const firstClose = vi.fn();
  const nextClose = vi.fn();
  await act(async () => root.render(<Dialog name="Editor" onClose={firstClose} />));
  const input = container.querySelector("textarea")!;
  input.focus();
  await act(async () => root.render(<Dialog name="Editor" onClose={nextClose} />));
  expect(document.activeElement).toBe(input);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  expect(nextClose).not.toHaveBeenCalled();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(nextClose).toHaveBeenCalledOnce();
  expect(firstClose).not.toHaveBeenCalled();
});
