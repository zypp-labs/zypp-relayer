import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./routes.js";

/**
 * The four unauthenticated routes, and the gate that must still hold for
 * everything else.
 *
 * `/`, `/docs`, `/robots.txt`, and `/health` are declared above the auth hook in
 * routes.ts, which reads as though it exempts them. It does not: Fastify binds
 * the hook chain to every route in the encapsulation context at `preReady`,
 * once all routes are registered, so declaration order has no effect. All four
 * returned 401 — `/health` to any external health check, `/robots.txt` to every
 * crawler it was written for.
 *
 * These boot the real `registerRoutes` and inject requests, unlike the static
 * source analysis in tenantScoping.test.ts. That style cannot see this bug:
 * the source *looks* correct, and the defect lives in Fastify's hook binding
 * rather than in anything the file says. Only a real request reveals it.
 *
 * The dependencies are doubles — no database, network, or Redis — so the suite
 * stays hermetic. They are shaped only well enough to reach a status code,
 * since these tests assert reachability, not payloads.
 */

const VALID_KEY = "zypp_test_valid_key";
const TEAM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

/**
 * Supabase double covering the two tables the request path touches: `api_keys`
 * for the auth hook, `jobs` for /health's probe. `findTeamByApiKey` hashes the
 * key before querying, so the lookup is keyed on the hash the same way.
 */
function fakeSupabase() {
  const validHash = createHash("sha256").update(VALID_KEY).digest("hex");

  const builder = (table: string) => {
    let matched = true;
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: [], error: null }),
      eq(column: string, value: unknown) {
        if (table === "api_keys" && column === "key_hash" && value !== validHash) {
          matched = false;
        }
        return chain;
      },
      maybeSingle: () =>
        Promise.resolve({
          data: table === "api_keys" && matched ? { team_id: TEAM_ID } : null,
          error: null,
        }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return chain;
  };

  return { from: builder } as never;
}

/** Reports healthy without a live Redis, so /health can return 200. */
const fakeQueue = {
  opts: { connection: { ping: async () => "PONG" } },
} as never;

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
} as never;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerRoutes(app, {
    supabase: fakeSupabase(),
    queue: fakeQueue,
    log: silentLog,
    intentDomain: "zypp-test",
    config: { RELAYER_INTENT_DOMAIN: "zypp-test" } as never,
    solBudgetStore: {} as never,
  });
  await app.ready();
  return app;
}

const PUBLIC_PATHS = ["/", "/docs", "/robots.txt", "/health"];

for (const path of PUBLIC_PATHS) {
  test(`${path} is reachable without an API key`, async (t) => {
    const app = await buildApp();
    t.after(() => app.close());

    const res = await app.inject({ method: "GET", url: path });

    assert.notEqual(
      res.statusCode,
      401,
      `${path} requires x-api-key. It is declared above the auth hook in ` +
        "routes.ts, but Fastify binds hooks to every route in the context at " +
        "preReady regardless of order — add it to PUBLIC_ROUTES.",
    );
    assert.ok(
      res.statusCode < 500,
      `${path} returned ${res.statusCode}; expected a successful or redirect status.`,
    );
  });
}

test("/health reports ok when its dependencies answer", async (t) => {
  // The status code is the whole contract with the platform's health check: a
  // reachable /health that always returns 503 fails a deploy just as surely as
  // a 401 does.
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/health" });

  assert.equal(res.statusCode, 200, `/health returned ${res.statusCode}: ${res.body}`);
  assert.equal(res.json().status, "ok");
});

test("robots.txt still disallows the ops paths", async (t) => {
  // The exemption exists so crawlers can read this file. If the body ever loses
  // the Disallow line, making it public has achieved nothing.
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/robots.txt" });

  assert.match(res.body, /Disallow: \/v1\/ops\//);
});

test("/docs serves the endpoint index instead of redirecting to itself", async (t) => {
  // REGRESSION. /docs used to answer `302 -> https://relayer.zypp.fun/docs`,
  // which is this same route as soon as that domain resolves to this service:
  // an infinite redirect, advertised to crawlers by the `Allow: /docs` line
  // above. It only looked fine because DNS had not been cut over yet, so
  // nothing ever followed the hop back.
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/docs" });

  assert.equal(res.statusCode, 200, `/docs returned ${res.statusCode}: ${res.body}`);
  assert.equal(
    res.headers.location,
    undefined,
    `/docs redirected to ${res.headers.location}. It must serve a body.`,
  );
  const body = res.json();
  assert.equal(body.authentication.header, "x-api-key");
  assert.ok(body.endpoints.length > 0, "The index must list at least one endpoint.");
});

test("the docs link / advertises actually resolves", async (t) => {
  // Ties the two together. The loop existed because `/` and `/docs` each named
  // an absolute URL and nothing checked that following it arrived anywhere.
  const app = await buildApp();
  t.after(() => app.close());

  const root = await app.inject({ method: "GET", url: "/" });
  const advertised = root.json().docs as string;

  assert.ok(
    advertised.startsWith("/"),
    `/ advertises ${advertised}. A relative path is the only form this test can follow, ` +
      "and the only form that stays correct when the service is reached by another hostname.",
  );

  const res = await app.inject({ method: "GET", url: advertised });
  assert.equal(res.statusCode, 200, `Following ${advertised} returned ${res.statusCode}.`);
});

// ─── The gate still holds ───

test("a /v1 route with no API key is rejected", async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/v1/ops/metrics" });

  assert.equal(res.statusCode, 401, "Opening the public routes must not open /v1.");
  assert.equal(res.json().code, "MISSING_API_KEY");
});

test("a /v1 route with an unrecognised API key is rejected", async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: "GET",
    url: "/v1/ops/metrics",
    headers: { "x-api-key": "zypp_not_a_real_key" },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "INVALID_API_KEY");
});

test("a /v1 route with a valid API key passes the auth hook", async (t) => {
  // Guards the inverse mistake: an exemption check that accidentally matched
  // everything would make every test above pass while disabling auth entirely.
  // This proves the hook still resolves a real key to a team.
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: "GET",
    url: "/v1/ops/metrics",
    headers: { "x-api-key": VALID_KEY },
  });

  assert.notEqual(res.statusCode, 401, "A valid key should clear the auth hook.");
});

test("a public route with a query string is still public", async (t) => {
  // The test that pins the choice of `request.routeOptions.url` over
  // `request.url`. Here the two differ: routeOptions.url is the registered
  // pattern "/health", while request.url is "/health?probe=1". An exact-match
  // exemption written against request.url would 401 this request, so any
  // platform health check configured with a cache-busting or region query
  // parameter would fail while a bare /health passed.
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/health?probe=1" });

  assert.notEqual(
    res.statusCode,
    401,
    "Match on request.routeOptions.url (the route pattern), not request.url.",
  );
});

test("an unmatched path is not treated as public", async (t) => {
  // routeOptions.url is undefined when nothing matched — the same value Fastify
  // uses to derive request.is404 — so a 404 cannot land in the exempt set.
  //
  // Either 401 or 404 is a pass. Whether instance-level onRequest hooks run for
  // an unmatched path is Fastify's business, and the property under test is only
  // that an unknown path is never treated as public. A 200 here would mean the
  // exemption had grown wide enough to match paths that do not exist.
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: "GET", url: "/definitely-not-a-route" });

  assert.ok(
    res.statusCode === 401 || res.statusCode === 404,
    `Unmatched path returned ${res.statusCode}; expected 401 or 404, never a served response.`,
  );
});
