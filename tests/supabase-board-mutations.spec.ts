import { beforeEach, expect, test, vi } from "vitest";
import type { AttachmentRecord } from "../lib/types";

const clientState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/supabase-client", () => ({
  requireSupabase: () => clientState.current,
}));

import { deleteBoardAttachment, reorderBoardAttachments } from "../lib/supabase-board";

const attachment: AttachmentRecord = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cardId: 7,
  objectKey: "owner/7/aaaaaaaa/screenshot.png",
  filename: "screenshot.png",
  contentType: "image/png",
  size: 128,
  sortOrder: 2,
  createdAt: "2026-09-06T00:00:00.000Z",
};

beforeEach(() => {
  clientState.current = null;
});

test("attachment reorder is committed by one atomic database RPC", async () => {
  const rpc = vi.fn().mockResolvedValue({ error: null });
  clientState.current = { rpc };

  await reorderBoardAttachments(7, ["attachment-b", "attachment-a"]);

  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("reorder_attachments", {
    p_card_id: 7,
    p_attachment_ids: ["attachment-b", "attachment-a"],
  });
});

test("failed storage deletion restores attachment metadata", async () => {
  const events: string[] = [];
  const remove = vi.fn().mockImplementation(async () => {
    events.push("storage");
    return { error: { message: "storage unavailable" } };
  });
  const insert = vi.fn().mockImplementation(async () => {
    events.push("restore");
    return { error: null };
  });
  const deleteEq = vi.fn().mockImplementation(async () => {
    events.push("metadata");
    return { error: null };
  });
  clientState.current = {
    from: vi.fn(() => ({
      delete: vi.fn(() => ({ eq: deleteEq })),
      insert,
    })),
    storage: { from: vi.fn(() => ({ remove })) },
  };

  await expect(deleteBoardAttachment(attachment)).rejects.toThrow(/记录已恢复/);

  expect(events).toEqual(["metadata", "storage", "restore"]);
  expect(insert).toHaveBeenCalledWith({
    id: attachment.id,
    card_id: attachment.cardId,
    object_key: attachment.objectKey,
    filename: attachment.filename,
    content_type: attachment.contentType,
    size: attachment.size,
    sort_order: attachment.sortOrder,
    created_at: attachment.createdAt,
  });
});

test("successful attachment deletion removes metadata before storage", async () => {
  const events: string[] = [];
  const remove = vi.fn().mockImplementation(async () => {
    events.push("storage");
    return { error: null };
  });
  const deleteEq = vi.fn().mockImplementation(async () => {
    events.push("metadata");
    return { error: null };
  });
  clientState.current = {
    from: vi.fn(() => ({
      delete: vi.fn(() => ({ eq: deleteEq })),
      insert: vi.fn(),
    })),
    storage: { from: vi.fn(() => ({ remove })) },
  };

  await deleteBoardAttachment(attachment);

  expect(events).toEqual(["metadata", "storage"]);
});
