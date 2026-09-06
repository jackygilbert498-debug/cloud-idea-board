import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260906_attachment_owner_integrity.sql", import.meta.url),
  "utf8",
);

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

const fixture = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role authenticated;

  create table public.cards (
    id bigint primary key,
    user_id uuid not null
  );
  create table public.attachments (
    id uuid primary key,
    card_id bigint not null references public.cards(id),
    user_id uuid not null,
    sort_order integer not null default 0
  );

  alter table public.cards enable row level security;
  alter table public.attachments enable row level security;
  create policy "Cards are private to their owner" on public.cards
    for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  create policy "Owners add attachments to their own cards" on public.attachments
    for insert to authenticated with check (
      user_id = auth.uid() and exists (
        select 1 from public.cards where cards.id = card_id and cards.user_id = auth.uid()
      )
    );
  create policy "Attachments are private to their owner" on public.attachments
    for select to authenticated using (user_id = auth.uid());
  create policy "Owners update their own attachments" on public.attachments
    for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

  grant usage on schema public, auth to authenticated;
  grant select on public.cards to authenticated;
  grant select, insert, update on public.attachments to authenticated;

  insert into public.cards values (1, '${OWNER_A}'), (2, '${OWNER_B}');
  insert into public.attachments values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, '${OWNER_A}', 0),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, '${OWNER_A}', 1),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2, '${OWNER_B}', 0);
`;

test("attachment ownership migration blocks cross-owner card reassignment", async () => {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    await db.exec(migration);
    await db.exec(migration);

    await db.exec(`set request.jwt.claim.sub = '${OWNER_A}'; set role authenticated;`);
    await db.query(
      "select public.reorder_attachments(1, array['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid])",
    );
    const reordered = await db.query(
      "select id from public.attachments where card_id = 1 order by sort_order",
    );
    expect(reordered.rows).toEqual([
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ]);
    await expect(
      db.query(
        "select public.reorder_attachments(1, array['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid])",
      ),
    ).rejects.toThrow(/attachment list does not match card/i);
    const allowed = await db.query(
      "update public.attachments set sort_order = 2 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' returning sort_order",
    );
    expect(allowed.rows).toEqual([{ sort_order: 2 }]);
    await expect(
      db.query(
        "update public.attachments set card_id = 2 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' returning card_id",
      ),
    ).rejects.toThrow(/attachment owner must match card owner|row-level security/i);

    await db.exec("reset role;");
    const stored = await db.query(
      "select card_id from public.attachments where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
    );
    expect(stored.rows).toEqual([{ card_id: 1 }]);

    await expect(
      db.query(
        `update public.attachments set user_id = '${OWNER_B}' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
      ),
    ).rejects.toThrow(/attachment owner must match card owner/i);
  } finally {
    await db.close();
  }
});

test("attachment ownership migration refuses pre-existing cross-owner rows", async () => {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    await db.exec(
      "update public.attachments set card_id = 2 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
    );

    await expect(db.exec(migration)).rejects.toThrow(/existing attachment owner mismatch/i);
  } finally {
    await db.close();
  }
});
