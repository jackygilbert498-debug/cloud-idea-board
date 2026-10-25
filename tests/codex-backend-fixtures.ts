import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export const ownerId = '11111111-1111-4111-8111-111111111111';
export const outsiderId = '22222222-2222-4222-8222-222222222222';
export const testEnv = {
  SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'server-key-never-return',
  CODEX_ALLOWED_USER_IDS: ownerId,
};

/** The network boundary delegates RPC calls to real PostgreSQL, not a mocked state machine. */
export async function backendFixture(github?: typeof fetch) {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261025_codex_tasks.sql', import.meta.url), 'utf8'));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/')) {
      if (!github) throw new Error('Unexpected GitHub request');
      return github(input, init);
    }
    if (url === 'https://supabase.example/auth/v1/user') {
      const auth = new Headers(init?.headers).get('authorization');
      return auth === 'Bearer valid-user-token-1234567890'
        ? Response.json({ id: ownerId })
        : auth === 'Bearer outsider-token-123456789000'
          ? Response.json({ id: outsiderId })
          : Response.json({ message: 'invalid' }, { status: 401 });
    }
    const name = url.split('/rest/v1/rpc/')[1];
    if (!/^codex_(user|runner|cloud)_action$/.test(name ?? '')) throw new Error('Unexpected RPC');
    if (new Headers(init?.headers).get('authorization') !== 'Bearer server-key-never-return') throw new Error('RPC used browser key');
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const entries = Object.entries(args);
    try {
      const result = await db.query<{ value: unknown }>(`select ${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(',')}) as value`, entries.map(([, value]) => typeof value === 'object' ? JSON.stringify(value) : value));
      return Response.json(result.rows[0].value);
    } catch (error) {
      return Response.json({ message: error instanceof Error ? error.message : 'db failure' }, { status: 400 });
    }
  };
  return { db, fetchImpl };
}

export function request(body: unknown, token = 'valid-user-token-1234567890') {
  return new Request('https://board.example/api/codex-tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
}
