import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20260824_memo_flow.sql", import.meta.url), "utf8");
const fixture = `
  create table cards (id bigint primary key, user_id uuid, stage text, focus boolean,
    updated_at timestamptz not null);
  create table attachments (id integer primary key, card_id bigint, created_at timestamptz);
  insert into cards values (1, null, 'done', true, '2026-08-20T00:00:00Z');
  insert into attachments values (1, 1, '2026-08-20'), (2, 1, '2026-08-21');
`;

test("migration initializes legacy rows but preserves user order when run again", async () => {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    await db.exec(migration);
    expect((await db.query("select sort_order from attachments order by id")).rows).toEqual([{ sort_order: 0 }, { sort_order: 1 }]);
    expect((await db.query("select previous_stage, focus from cards")).rows).toEqual([{ previous_stage: "todo", focus: false }]);
    await db.exec("update attachments set sort_order = case id when 1 then 1 else 0 end;");
    await db.exec(migration);
    expect((await db.query("select sort_order from attachments order by id")).rows).toEqual([{ sort_order: 1 }, { sort_order: 0 }]);
  } finally { await db.close(); }
});

test("migration preserves order in databases where the column already exists", async () => {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    await db.exec("alter table attachments add column sort_order integer not null default 0; update attachments set sort_order = case id when 1 then 7 else 3 end;");
    await db.exec(migration);
    expect((await db.query("select sort_order from attachments order by id")).rows).toEqual([{ sort_order: 7 }, { sort_order: 3 }]);
  } finally { await db.close(); }
});
