import { existsSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const ALICE_ID = "10000000-0000-4000-8000-000000000001";
const BOB_ID = "10000000-0000-4000-8000-000000000002";
const ATTACHMENT_A_ID = "20000000-0000-4000-8000-000000000001";
const ATTACHMENT_B_ID = "20000000-0000-4000-8000-000000000002";
const PENDING_ATTACHMENT_ID = "20000000-0000-4000-8000-000000000003";
const REQUEST_ID = "30000000-0000-4000-8000-000000000001";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const memoMigration = readFileSync(new URL("../supabase/migrations/20260824_memo_flow.sql", import.meta.url), "utf8");
const aiMigration = readFileSync(new URL("../supabase/migrations/20260824_restore_ai_organizer.sql", import.meta.url), "utf8");
const stabilizationMigrationUrl = new URL("../supabase/migrations/202609050001_product_stabilization.sql", import.meta.url);
const stabilizationMigration = existsSync(stabilizationMigrationUrl)
  ? readFileSync(stabilizationMigrationUrl, "utf8")
  : "";

function createDatabase() {
  return new PGlite({ extensions: { pgcrypto } });
}

async function installAuthAndStorageFixtures(db: PGlite) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;

    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid
    language sql stable
    set search_path = ''
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null,
      name text not null
    );
    create function storage.foldername(name text) returns text[]
    language sql immutable
    set search_path = ''
    as $$ select string_to_array(name, '/') $$;

    insert into auth.users (id) values ('${ALICE_ID}'), ('${BOB_ID}');
  `);
}

async function grantAuthenticatedTableAccess(db: PGlite) {
  await db.exec(`
    grant usage on schema public, auth, storage to authenticated, service_role;
    grant select, insert, update, delete on public.cards, public.attachments to authenticated;
    grant usage, select on all sequences in schema public to authenticated;
  `);
}

async function assumeRole(db: PGlite, role: "authenticated" | "service_role", userId = ALICE_ID) {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${userId}', false);
    set role ${role};
  `);
}

async function resetRole(db: PGlite) {
  await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
}

async function seedCards(db: PGlite) {
  await db.exec(`
    insert into public.cards (id, user_id, title, stage, focus)
    values
      (1, '${ALICE_ID}', 'Alice card', 'idea', false),
      (2, '${BOB_ID}', 'Bob card', 'idea', false);
  `);
}

async function seedThreeFocusedCards(db: PGlite) {
  await db.exec(`
    insert into public.cards (user_id, title, stage, focus)
    values
      ('${ALICE_ID}', 'Focus 1', 'idea', true),
      ('${ALICE_ID}', 'Focus 2', 'todo', true),
      ('${ALICE_ID}', 'Focus 3', 'doing', true);
  `);
}

test("the complete schema and every migration can run twice", async () => {
  const db = createDatabase();
  try {
    await installAuthAndStorageFixtures(db);
    await db.exec(schema);
    await db.exec(schema);
    await db.exec(memoMigration);
    await db.exec(memoMigration);
    await db.exec(aiMigration);
    await db.exec(aiMigration);
    expect(stabilizationMigration).not.toBe("");
    await db.exec(stabilizationMigration);
    await db.exec(stabilizationMigration);
  } finally {
    await db.close();
  }
});

describe("stabilized database invariants", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = createDatabase();
    await installAuthAndStorageFixtures(db);
    await db.exec(schema);
    if (stabilizationMigration) await db.exec(stabilizationMigration);
    await grantAuthenticatedTableAccess(db);
  });

  afterEach(async () => {
    await db.close();
  });

  test("a fourth active focus is rejected", async () => {
    await seedThreeFocusedCards(db);
    await expect(db.exec(`
      insert into public.cards (user_id, title, stage, focus)
      values ('${ALICE_ID}', 'Focus 4', 'idea', true);
    `)).rejects.toThrow(/最多保留 3 条/);
  });

  test("focus acquisition holds a transaction advisory lock for its owner", async () => {
    await db.exec("begin;");
    try {
      await db.exec(`
        insert into public.cards (user_id, title, stage, focus)
        values ('${ALICE_ID}', 'Serialized focus', 'idea', true);
      `);
      expect((await db.query(`
        select count(*)::integer as count
        from pg_locks
        where locktype = 'advisory'
          and pid = pg_backend_pid()
          and granted;
      `)).rows).toEqual([{ count: 1 }]);
    } finally {
      await db.exec("rollback;");
    }
  });

  test("a client request id creates at most one card per user", async () => {
    await db.exec(`
      insert into public.cards (user_id, title, client_request_id)
      values ('${ALICE_ID}', 'First attempt', '${REQUEST_ID}');
    `);
    await expect(db.exec(`
      insert into public.cards (user_id, title, client_request_id)
      values ('${ALICE_ID}', 'Retry', '${REQUEST_ID}');
    `)).rejects.toThrow(/unique|duplicate/i);
    await expect(db.exec(`
      insert into public.cards (user_id, title, client_request_id)
      values ('${BOB_ID}', 'Other owner', '${REQUEST_ID}');
    `)).resolves.toBeDefined();
  });

  test("legacy attachments become ready while new rows default to pending", async () => {
    const legacyDb = createDatabase();
    try {
      await installAuthAndStorageFixtures(legacyDb);
      await legacyDb.exec(schema);
      await legacyDb.exec(`
        alter table public.attachments
          drop column if exists state,
          drop column if exists updated_at;
        create table public.constraint_name_decoy (
          state text constraint attachments_state_check
            check (state in ('pending', 'ready', 'deleting'))
        );
      `);
      await seedCards(legacyDb);
      await legacyDb.exec(`
        insert into public.attachments
          (id, card_id, user_id, object_key, filename, content_type, size)
        values
          ('${ATTACHMENT_A_ID}', 1, '${ALICE_ID}', '${ALICE_ID}/legacy.png', 'legacy.png', 'image/png', 10);
      `);
      expect(stabilizationMigration).not.toBe("");
      await legacyDb.exec(stabilizationMigration);
      await legacyDb.exec(`
        insert into public.attachments
          (id, card_id, user_id, object_key, filename, content_type, size)
        values
          ('${ATTACHMENT_B_ID}', 1, '${ALICE_ID}', '${ALICE_ID}/new.png', 'new.png', 'image/png', 10);
      `);
      expect((await legacyDb.query("select id, state from public.attachments order by id")).rows).toEqual([
        { id: ATTACHMENT_A_ID, state: "ready" },
        { id: ATTACHMENT_B_ID, state: "pending" },
      ]);
      await expect(legacyDb.exec(`
        insert into public.attachments
          (card_id, user_id, object_key, filename, content_type, size, state)
        values
          (1, '${ALICE_ID}', '${ALICE_ID}/invalid.png', 'invalid.png', 'image/png', 10, 'invalid');
      `)).rejects.toThrow(/attachments_state_check/);
    } finally {
      await legacyDb.close();
    }
  });

  test("attachment updates preserve both card ownership and object-key ownership", async () => {
    await seedCards(db);
    await db.exec(`
      insert into public.attachments
        (id, card_id, user_id, object_key, filename, content_type, size, state)
      values
        ('${ATTACHMENT_A_ID}', 1, '${ALICE_ID}', '${ALICE_ID}/a.png', 'a.png', 'image/png', 10, 'ready');
    `);
    await assumeRole(db, "authenticated");
    try {
      await expect(db.exec(`update public.attachments set card_id = 2 where id = '${ATTACHMENT_A_ID}';`))
        .rejects.toThrow(/row-level security/i);
      await expect(db.exec(`update public.attachments set object_key = '${BOB_ID}/a.png' where id = '${ATTACHMENT_A_ID}';`))
        .rejects.toThrow(/row-level security/i);
    } finally {
      await resetRole(db);
    }
  });

  test("ready attachment ids reorder atomically only when the set is exact", async () => {
    await seedCards(db);
    await db.exec(`
      insert into public.attachments
        (id, card_id, user_id, object_key, filename, content_type, size, state, sort_order)
      values
        ('${ATTACHMENT_A_ID}', 1, '${ALICE_ID}', '${ALICE_ID}/a.png', 'a.png', 'image/png', 10, 'ready', 0),
        ('${ATTACHMENT_B_ID}', 1, '${ALICE_ID}', '${ALICE_ID}/b.png', 'b.png', 'image/png', 10, 'ready', 1),
        ('${PENDING_ATTACHMENT_ID}', 1, '${ALICE_ID}', '${ALICE_ID}/pending.png', 'pending.png', 'image/png', 10, 'pending', 7);
    `);
    await assumeRole(db, "authenticated");
    try {
      await expect(db.exec(`
        select public.reorder_attachments(1, array['${ATTACHMENT_B_ID}']::uuid[]);
      `)).rejects.toThrow(/附件集合不匹配/);
      await expect(db.exec(`
        select public.reorder_attachments(
          1,
          array['${ATTACHMENT_A_ID}', '${PENDING_ATTACHMENT_ID}']::uuid[]
        );
      `)).rejects.toThrow(/附件集合不匹配/);
      await expect(db.exec(`
        select public.reorder_attachments(
          1,
          array['${ATTACHMENT_A_ID}', '${ATTACHMENT_A_ID}']::uuid[]
        );
      `)).rejects.toThrow(/附件集合不匹配/);
    } finally {
      await resetRole(db);
    }
    expect((await db.query("select id, sort_order from public.attachments order by id")).rows).toEqual([
      { id: ATTACHMENT_A_ID, sort_order: 0 },
      { id: ATTACHMENT_B_ID, sort_order: 1 },
      { id: PENDING_ATTACHMENT_ID, sort_order: 7 },
    ]);

    await assumeRole(db, "authenticated");
    try {
      await db.exec(`
        select public.reorder_attachments(
          1,
          array['${ATTACHMENT_B_ID}', '${ATTACHMENT_A_ID}']::uuid[]
        );
      `);
    } finally {
      await resetRole(db);
    }
    expect((await db.query("select id, sort_order from public.attachments order by id")).rows).toEqual([
      { id: ATTACHMENT_A_ID, sort_order: 1 },
      { id: ATTACHMENT_B_ID, sort_order: 0 },
      { id: PENDING_ATTACHMENT_ID, sort_order: 7 },
    ]);
  });

  test("daily AI quota rejects limit plus one and is callable only by service role", async () => {
    expect((await db.query(`
      select
        has_function_privilege('authenticated', 'public.consume_ai_daily_quota(uuid, integer)', 'execute') as authenticated,
        has_function_privilege('anon', 'public.consume_ai_daily_quota(uuid, integer)', 'execute') as anon,
        has_function_privilege('service_role', 'public.consume_ai_daily_quota(uuid, integer)', 'execute') as service_role;
    `)).rows).toEqual([{ authenticated: false, anon: false, service_role: true }]);

    await assumeRole(db, "authenticated");
    try {
      await expect(db.exec(`select public.consume_ai_daily_quota('${ALICE_ID}', 2);`))
        .rejects.toThrow(/permission denied/i);
    } finally {
      await resetRole(db);
    }

    await assumeRole(db, "service_role");
    try {
      await expect(db.exec(`select public.consume_ai_daily_quota('${ALICE_ID}', 2);`)).resolves.toBeDefined();
      await expect(db.exec(`select public.consume_ai_daily_quota('${ALICE_ID}', 2);`)).resolves.toBeDefined();
      await expect(db.exec(`select public.consume_ai_daily_quota('${ALICE_ID}', 2);`))
        .rejects.toThrow(/AI_DAILY_QUOTA_EXCEEDED/);
    } finally {
      await resetRole(db);
    }
  });
});
