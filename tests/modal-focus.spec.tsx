// @vitest-environment jsdom
import { act, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { IdeaBoard } from "@/app/components/IdeaBoard";
import App from "@/src/App";
import type { AttachmentRecord, CardRecord } from "@/lib/types";
import { useModalFocus } from "@/lib/use-modal-focus";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  cards: [] as CardRecord[],
  list: null as null | (() => Promise<CardRecord[]>),
  authSession: null as Session | null,
  getSession: null as null | (() => Promise<{ data: { session: Session | null }; error: Error | null }>),
  listener: null as null | ((event: AuthChangeEvent, session: Session | null) => void),
}));

vi.mock("@/lib/supabase-client", () => {
  const client = { auth: {
    getSession: () => fixture.getSession
      ? fixture.getSession()
      : Promise.resolve({ data: { session: fixture.authSession }, error: null }),
    onAuthStateChange: (listener: typeof fixture.listener) => {
      fixture.listener = listener;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    signInWithPassword: async () => ({ data: { session: null }, error: null }),
    resetPasswordForEmail: async () => ({ error: null }),
    updateUser: async () => ({ error: null }),
    signOut: async () => ({ error: null }),
    dispose: async () => undefined,
  } };
  return {
    supabase: client,
    getSupabaseAuthMode: () => "persistent",
    getSupabaseAuthError: () => null,
    configureSupabaseAuthMode: async () => client,
    requireSupabase: () => { throw new Error("Unexpected Supabase access in modal DOM test"); },
  };
});

vi.mock("@/lib/supabase-board", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/supabase-board")>();
  return {
    ...original,
    listBoardCards: async () => fixture.list ? fixture.list() : fixture.cards,
    reconcileBoardAttachments: async () => undefined,
    updateBoardCard: async (_id: number, patch: Partial<CardRecord>, known: CardRecord) => ({ ...known, ...patch }),
    createBoardCard: async () => fixture.cards[0],
    uploadBoardAttachment: async () => undefined,
    reorderBoardAttachments: async () => undefined,
    deleteBoardAttachment: async () => undefined,
  };
});

const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot> | null = null;

function attachment(): AttachmentRecord {
  return {
    id: "attachment-1",
    cardId: 1,
    objectKey: "alice/1/attachment-1.png",
    filename: "参考图.png",
    contentType: "image/png",
    size: 128,
    sortOrder: 0,
    state: "ready",
    createdAt: "2026-09-06T00:00:00Z",
    url: "https://example.test/reference.png",
  };
}

function card(): CardRecord {
  return {
    id: 1,
    title: "可访问弹层",
    stage: "idea",
    criteria: "",
    result: "",
    originalText: "",
    organizedText: "",
    aiAnalysis: null,
    aiModel: null,
    aiPromptVersion: null,
    aiOrganizedAt: null,
    originalTextUpdatedAt: null,
    focus: false,
    archived: false,
    reference: false,
    sortOrder: 1,
    completedAt: null,
    previousStage: null,
    createdAt: "2026-09-06T00:00:00Z",
    updatedAt: "2026-09-06T00:00:00Z",
    attachments: [attachment()],
  };
}

function matchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches, media: "(max-width: 720px)", onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })));
}

async function renderBoard(mobile = false, cards: CardRecord[] = [card()], expectedSelector = ".task-card-main") {
  matchMedia(mobile);
  fixture.cards = cards;
  root = createRoot(container);
  await act(async () => {
    root!.render(<IdeaBoard userId="alice" displayName="alice@example.com" authMode="persistent"
      isIdentityActive={() => true} onUpdatePassword={async () => undefined} onSignOut={async () => undefined} />);
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(container.querySelector(expectedSelector)).not.toBeNull());
}

function clipboardPaste(target: Element, items: Array<{ type: string; getAsFile: () => File | null }>): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items } });
  target.dispatchEvent(event);
  return event;
}

function FocusHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const [dynamic, setDynamic] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const close = () => { onClose(); setOpen(false); };
  useModalFocus({ containerRef, initialFocusRef, onClose: close, active: open });
  return <>
    <button id="stable-focus-opener" data-modal-focus-id="card-1" onClick={() => setOpen(true)}>打开弹层</button>
    <button id="outside-focus-target">外部按钮</button>
    {open && <div ref={containerRef} role="dialog" aria-modal="true">
      <button ref={initialFocusRef}>第一个</button>
      <button onClick={() => setDynamic(true)}>增加控件</button>
      {dynamic && <button>动态控件</button>}
      <button onClick={close}>最后一个</button>
    </div>}
  </>;
}

function FocusPredicateHarness() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useModalFocus({ containerRef, initialFocusRef, onClose: close, active: open });
  return <>
    <button onClick={() => setOpen(true)}>打开过滤测试</button>
    {open && <div ref={containerRef} role="dialog" tabIndex={-1}>
      <button ref={initialFocusRef}>首个可见控件</button>
      <button>最后可见控件</button>
      <button disabled tabIndex={0}>显式 tabIndex 的禁用按钮</button>
      <button hidden>hidden 控件</button>
      <div aria-hidden="true"><button>aria-hidden 祖先内控件</button></div>
      <div style={{ display: "none" }}><button>display none 祖先内控件</button></div>
      <div style={{ visibility: "hidden" }}><button>visibility hidden 祖先内控件</button></div>
      <div inert><button>inert 祖先内控件</button></div>
    </div>}
  </>;
}

function ZeroFocusHarness() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  useModalFocus({ containerRef, initialFocusRef, onClose: () => setOpen(false), active: open });
  return <><button onClick={() => setOpen(true)}>打开空弹层</button>{open && <div ref={containerRef} role="dialog">没有控件</div>}</>;
}

function cssRule(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start) + 1);
}

function pixelValue(rule: string, property: string) {
  const match = rule.match(new RegExp(`${property}:\\s*(\\d+)px`));
  expect(match, `missing ${property} in ${rule}`).not.toBeNull();
  return Number(match![1]);
}

function contrastAgainstWhite(hex: string) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return 1.05 / (luminance + 0.05);
}

beforeEach(() => {
  localStorage.clear();
  fixture.cards = [];
  fixture.list = null;
  fixture.authSession = null;
  fixture.getSession = null;
  fixture.listener = null;
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL() {} });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.replaceChildren();
  vi.unstubAllGlobals();
  document.getElementById("equivalent-focus-opener")?.remove();
  document.getElementById("mobile-visibility-fixture")?.remove();
  document.querySelector('[data-modal-focus-fallback="test"]')?.remove();
});

test("focusable filtering skips disabled and visually hidden descendants and focuses an empty container", async () => {
  root = createRoot(container);
  await act(async () => root!.render(<FocusPredicateHarness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  const first = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))[0];
  const lastVisible = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))[1];
  first.focus();
  const reverse = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(reverse);
  expect(reverse.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(lastVisible);

  await act(async () => root!.unmount());
  root = createRoot(container);
  await act(async () => root!.render(<ZeroFocusHarness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const emptyDialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(emptyDialog.tabIndex).toBe(-1);
  expect(document.activeElement).toBe(emptyDialog);
});

test("modal focus dynamically wraps both directions, rejects escape and restores a stable opener", async () => {
  let closeCalls = 0;
  root = createRoot(container);
  await act(async () => root!.render(<StrictMode><FocusHarness onClose={() => { closeCalls += 1; }} /></StrictMode>));
  const opener = container.querySelector<HTMLButtonElement>("#stable-focus-opener")!;
  opener.focus();
  await act(async () => opener.click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  const first = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))[0];
  expect(document.activeElement).toBe(first);

  await act(async () => Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))[1].click());
  const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
  const last = buttons.at(-1)!;
  last.focus();
  const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  document.dispatchEvent(forward);
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);

  const reverse = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(reverse);
  expect(reverse.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(last);

  container.querySelector<HTMLButtonElement>("#outside-focus-target")!.focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
  const composingEscape = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
  document.dispatchEvent(composingEscape);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(composingEscape.defaultPrevented).toBe(false);

  opener.remove();
  const equivalent = document.createElement("button");
  equivalent.id = "moved-column-focus-opener";
  equivalent.dataset.modalFocusId = "card-1";
  equivalent.textContent = "移动后的同一卡片";
  document.body.append(equivalent);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => document.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(closeCalls).toBe(1);
  expect(document.activeElement).toBe(equivalent);
  equivalent.remove();
  container.append(opener);
});

test("focus restoration ignores a hidden replacement and uses an explicit safe fallback", async () => {
  root = createRoot(container);
  await act(async () => root!.render(<FocusHarness onClose={() => undefined} />));
  const opener = container.querySelector<HTMLButtonElement>("#stable-focus-opener")!;
  opener.focus();
  await act(async () => opener.click());
  opener.remove();

  const hiddenReplacement = document.createElement("button");
  hiddenReplacement.id = "stable-focus-opener";
  hiddenReplacement.dataset.modalFocusId = "card-1";
  hiddenReplacement.style.display = "none";
  document.body.append(hiddenReplacement);
  const fallback = document.createElement("main");
  fallback.tabIndex = -1;
  fallback.dataset.modalFocusFallback = "test";
  document.body.append(fallback);

  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(fallback);

  hiddenReplacement.remove();
  container.append(opener);
});

test("all card entry points share logical focus identity and restore across projection changes", async () => {
  await renderBoard(false, [{ ...card(), focus: true }]);
  const main = container.querySelector<HTMLElement>(".desktop-board .task-card-main")!;
  const more = container.querySelector<HTMLElement>(".desktop-board .card-more")!;
  const focusOpener = container.querySelector<HTMLButtonElement>(".focus-items button")!;
  expect([main, more, focusOpener].map((element) => element.dataset.modalFocusId)).toEqual(["card-1", "card-1", "card-1"]);

  focusOpener.focus();
  await act(async () => focusOpener.click());
  const removeFocus = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"))
    .find((button) => button.textContent?.includes("移出今日焦点"))!;
  await act(async () => { removeFocus.click(); await Promise.resolve(); });
  await vi.waitFor(() => expect(container.querySelector(".focus-items button")).toBeNull());
  await act(async () => container.querySelector<HTMLButtonElement>('.editor > header [aria-label="关闭"]')!.click());
  expect(document.activeElement).toBe(main);

  const listNav = Array.from(container.querySelectorAll<HTMLButtonElement>(".desktop-nav button"))
    .find((button) => button.textContent?.includes("清单"))!;
  await act(async () => listNav.click());
  expect(container.querySelector<HTMLElement>(".list-row")?.dataset.modalFocusId).toBe("card-1");

  await act(async () => root!.unmount());
  root = null;
  container.replaceChildren();
  await renderBoard(false, [{ ...card(), archived: true }], ".desktop-nav");
  const archiveNav = Array.from(container.querySelectorAll<HTMLButtonElement>(".desktop-nav button"))
    .find((button) => button.textContent?.includes("档案库"))!;
  await act(async () => archiveNav.click());
  expect(container.querySelector<HTMLElement>(".archive-row-main")?.dataset.modalFocusId).toBe("card-1");
  expect(container.querySelector<HTMLElement>(".archive-thumb")?.dataset.modalFocusId).toBe("attachment-attachment-1");
});

test("closing after a desktop-to-mobile switch restores the visible mobile card", async () => {
  await renderBoard();
  const desktopMore = container.querySelector<HTMLButtonElement>(".desktop-board .card-more")!;
  desktopMore.focus();
  await act(async () => desktopMore.click());
  const responsiveStyle = document.createElement("style");
  responsiveStyle.id = "mobile-visibility-fixture";
  responsiveStyle.textContent = ".desktop-board { display: none !important; } .mobile-board-panel { display: block !important; }";
  document.head.append(responsiveStyle);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(container.querySelector(".mobile-board-panel .task-card-main"));
});

test("Editor and viewer expose labelled dialogs, nested ownership and two-step Escape restoration", async () => {
  await renderBoard();
  const cardOpener = container.querySelector<HTMLButtonElement>(".task-card-main")!;
  const cardAttachmentOpener = container.querySelector<HTMLElement>(".card-image-button")!;
  expect(container.querySelector<HTMLElement>("main.app-shell")?.tabIndex).toBe(-1);
  expect(container.querySelector("main.app-shell")?.hasAttribute("data-modal-focus-fallback")).toBe(true);
  cardOpener.focus();
  await act(async () => cardOpener.click());

  const editor = container.querySelector<HTMLElement>(".editor")!;
  const title = editor.querySelector<HTMLTextAreaElement>(".title-field textarea")!;
  expect(document.activeElement).toBe(title);
  expect(editor.getAttribute("aria-labelledby")).toBeTruthy();
  expect(document.getElementById(editor.getAttribute("aria-labelledby")!)?.textContent).toContain("编辑记录");

  const attachmentOpener = editor.querySelector<HTMLElement>(".attachment-preview")!;
  expect(attachmentOpener.dataset.modalFocusId).toBe(cardAttachmentOpener.dataset.modalFocusId);
  attachmentOpener.focus();
  const mobileVisibility = document.createElement("style");
  mobileVisibility.id = "mobile-visibility-fixture";
  mobileVisibility.textContent = ".image-viewer .desktop-only { display: none !important; }";
  document.head.append(mobileVisibility);
  await act(async () => attachmentOpener.click());
  const viewer = container.querySelector<HTMLElement>(".image-viewer")!;
  expect(viewer.getAttribute("aria-labelledby")).toBeTruthy();
  expect(document.getElementById(viewer.getAttribute("aria-labelledby")!)?.textContent).toBe("参考图.png");
  expect(document.activeElement).toBe(viewer.querySelector('[aria-label="关闭截图"]'));
  expect(viewer.getAttribute("aria-modal")).toBe("true");
  expect(editor.hasAttribute("inert")).toBe(true);
  expect(editor.getAttribute("aria-hidden")).toBe("true");
  expect(editor.hasAttribute("aria-modal")).toBe(false);
  expect(editor.tabIndex).toBe(-1);
  expect(viewer.tabIndex).toBe(-1);

  const reverse = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(reverse);
  expect(reverse.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(viewer.querySelector<HTMLButtonElement>('[aria-label="放大"]'));

  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(container.querySelector(".image-viewer")).toBeNull();
  expect(container.querySelector(".editor")).not.toBeNull();
  expect(document.activeElement).toBe(attachmentOpener);

  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(container.querySelector(".editor")).toBeNull();
  expect(document.activeElement).toBe(cardOpener);
});

test("mobile menu and stage filters expose button state without tab semantics", async () => {
  await renderBoard(true);
  const menuButton = container.querySelector<HTMLButtonElement>(".mobile-menu-button")!;
  expect(menuButton.getAttribute("aria-expanded")).toBe("false");
  expect(menuButton.getAttribute("aria-label")).toBe("打开导航");
  expect(menuButton.getAttribute("aria-controls")).toBeTruthy();
  await act(async () => menuButton.click());
  const menu = document.getElementById(menuButton.getAttribute("aria-controls")!);
  expect(menu).not.toBeNull();
  expect(menuButton.getAttribute("aria-expanded")).toBe("true");
  expect(menuButton.getAttribute("aria-label")).toBe("关闭导航");
  expect(menu?.querySelector('[aria-current="page"]')?.textContent).toContain("看板");

  const stages = Array.from(container.querySelectorAll<HTMLButtonElement>(".mobile-tabs button"));
  expect(container.querySelector('.mobile-tabs[role="tablist"]')).toBeNull();
  expect(stages).toHaveLength(4);
  expect(stages[0].getAttribute("aria-pressed")).toBe("true");
  expect(stages.every((button) => button.getAttribute("role") !== "tab")).toBe(true);
});

test("authentication and board restoration expose polite loading status", async () => {
  fixture.getSession = () => new Promise(() => undefined);
  root = createRoot(container);
  await act(async () => root!.render(<App />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("正在确认登录状态");
  await act(async () => root!.unmount());
  root = null;
  container.replaceChildren();

  fixture.list = () => new Promise(() => undefined);
  matchMedia(false);
  root = createRoot(container);
  await act(async () => root!.render(<IdeaBoard userId="alice" displayName="alice@example.com" authMode="persistent"
    isIdentityActive={() => true} onUpdatePassword={async () => undefined} onSignOut={async () => undefined} />));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("正在读取你的构思");
});

test("attachment picker has a named controlled input and platform-neutral copy", async () => {
  await renderBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const upload = container.querySelector<HTMLButtonElement>(".upload-button")!;
  expect(input.id).toBeTruthy();
  expect(input.name).toBe("attachments");
  expect(input.getAttribute("aria-label")).toContain("截图");
  expect(input.tabIndex).toBe(-1);
  expect(upload.getAttribute("aria-controls")).toBe(input.id);
  expect(upload.textContent).toContain("粘贴");
  expect(upload.textContent).not.toContain("⌘V");
});

test("desktop image paste is handled while mobile mixed paste remains available to text input", async () => {
  await renderBoard(false);
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const title = container.querySelector(".title-field textarea")!;
  const file = new File(["png"], "粘贴图.png", { type: "image/png" });
  let pasteEvent!: Event;
  await act(async () => {
    pasteEvent = clipboardPaste(title, [{ type: "image/png", getAsFile: () => file }]);
  });
  expect(pasteEvent.defaultPrevented).toBe(true);
  expect(container.querySelector(".pending-preview")?.textContent).toContain("粘贴图.png");

  const titleBeforeMixedPaste = (title as HTMLTextAreaElement).value;
  const secondFile = new File(["png"], "混合粘贴图.png", { type: "image/png" });
  await act(async () => {
    pasteEvent = clipboardPaste(title, [
      { type: "text/plain", getAsFile: () => null },
      { type: "image/png", getAsFile: () => secondFile },
    ]);
  });
  expect(pasteEvent.defaultPrevented).toBe(false);
  expect((title as HTMLTextAreaElement).value).toBe(titleBeforeMixedPaste);
  expect(Array.from(container.querySelectorAll(".pending-preview")).map((preview) => preview.textContent)).toContain("混合粘贴图.png");

  await act(async () => root!.unmount());
  root = null;
  container.replaceChildren();
  await renderBoard(true);
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const mobileTitle = container.querySelector(".title-field textarea")!;
  await act(async () => {
    pasteEvent = clipboardPaste(mobileTitle, [
      { type: "text/plain", getAsFile: () => null },
      { type: "image/png", getAsFile: () => file },
    ]);
  });
  expect(pasteEvent.defaultPrevented).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("选择截图");
});

test("Space activation prevents scrolling and opens one viewer without nested retry controls", async () => {
  await renderBoard();
  const opener = container.querySelector<HTMLElement>(".card-image-button")!;
  const image = opener.querySelector("img")!;
  await act(async () => image.dispatchEvent(new Event("error", { bubbles: true })));
  expect(opener.querySelector("button")).toBeNull();

  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => opener.dispatchEvent(space));
  expect(space.defaultPrevented).toBe(true);
  expect(container.querySelectorAll(".image-viewer")).toHaveLength(1);
  await act(async () => opener.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true })));
  expect(container.querySelectorAll(".image-viewer")).toHaveLength(1);
});

test("mobile touch targets, information text and contrast tokens meet the approved accessibility floor", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const mobileStart = css.indexOf("@media (max-width: 720px)");
  const mobileEnd = css.indexOf("@media (prefers-reduced-motion: reduce)");
  const mobileCss = css.slice(mobileStart, mobileEnd);

  for (const selector of [
    ".search",
    ".remote-image-error button",
    ".ai-button",
    ".archive-thumb",
    ".restore-button",
    ".undo-toast button",
    ".auth-input",
    ".account-password-form input",
    ".account-actions button",
    ".editor > header button",
  ]) {
    expect(pixelValue(cssRule(mobileCss, selector), "min-height"), selector).toBeGreaterThanOrEqual(44);
  }
  for (const selector of [".remote-image-error button", ".archive-thumb", ".restore-button", ".undo-toast button", ".editor > header button"]) {
    expect(pixelValue(cssRule(mobileCss, selector), "min-width"), selector).toBeGreaterThanOrEqual(44);
  }

  for (const selector of [
    ".card-meta",
    ".focus-items button span",
    ".result-count",
    ".list-header",
    ".list-row small, .list-row time, .archive-row small",
    ".archive-group > header span",
    ".image-viewer > header span",
  ]) {
    expect(pixelValue(cssRule(css, selector), "font-size"), selector).toBeGreaterThanOrEqual(12);
  }
  expect(pixelValue(cssRule(mobileCss, ".list-row small"), "font-size")).toBeGreaterThanOrEqual(12);
  expect(pixelValue(cssRule(mobileCss, ".archive-row small"), "font-size")).toBeGreaterThanOrEqual(12);

  const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1] ?? "";
  expect(contrastAgainstWhite(token("muted"))).toBeGreaterThanOrEqual(4.5);
  expect(contrastAgainstWhite(token("weak"))).toBeGreaterThanOrEqual(4.5);
  expect(cssRule(css, ".search input::placeholder")).toContain("var(--weak)");
  expect(cssRule(css, ".field textarea::placeholder")).toContain("var(--weak)");
  expect(cssRule(css, "input::placeholder, textarea::placeholder")).toContain("var(--weak)");

  const focusOutline = cssRule(css, 'button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, a:focus-visible, [role="button"]:focus-visible')
    .match(/outline:\s*2px solid (#[0-9a-f]{6})/i)?.[1] ?? "";
  expect(contrastAgainstWhite(focusOutline)).toBeGreaterThanOrEqual(3);
  const organizerOutline = cssRule(css, ".idea-organizer button:focus-visible, .idea-organizer input:focus-visible, .idea-organizer textarea:focus-visible")
    .match(/outline:\s*2px solid (#[0-9a-f]{6})/i)?.[1] ?? "";
  expect(contrastAgainstWhite(organizerOutline)).toBeGreaterThanOrEqual(3);
  const fieldOutline = cssRule(css, ".search input:focus-visible, .field textarea:focus-visible, .title-choice input:focus-visible, .auth-input input:focus-visible, .account-password-form input:focus-visible")
    .match(/outline:\s*2px solid (#[0-9a-f]{6})/i)?.[1] ?? "";
  expect(contrastAgainstWhite(fieldOutline)).toBeGreaterThanOrEqual(3);
});
