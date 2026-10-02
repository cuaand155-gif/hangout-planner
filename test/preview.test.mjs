import test from "node:test";
import assert from "node:assert/strict";

import pageHandler, { withPreview } from "../api/page.js";
import ogHandler, { cardFor, headlineSize } from "../api/og.js";
import { GENERIC_PREVIEW, cleanText, previewFor } from "../api/_preview.js";
import { normalizeWorkspaceState } from "../lib/planner.js";
import { createFakeSupabase, installFakeSupabase } from "../scripts/fake-supabase.mjs";

const CODE = "PreviewCode0123456789abc";
const NAMES = ["Alexi", "Sam Rivera", "Jordan", "alexi@example.com", "Climbing", "Basecamp", "Luma", "Kensington"];

function group(extra = {}) {
  return normalizeWorkspaceState({
    name: "Book club",
    privacy: "details",
    invite: { code: CODE },
    members: [
      { id: "m_a", name: "Alexi", email: "alexi@example.com", userId: "u1", busy: [{ start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", title: "Climbing", location: "Basecamp" }] },
      { id: "m_s", name: "Sam Rivera" },
      { id: "m_j", name: "Jordan", guest: true },
    ],
    plan: { activity: "Board games", location: "Luma, Kensington", audience: "Sam Rivera", timing: "week" },
    ...extra,
  });
}

function mockResponse() {
  const captured = { headers: {}, status: null, body: null };
  return {
    captured,
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    status(code) {
      captured.status = code;
      return this;
    },
    end(body) {
      captured.body = body;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
}

function withDb(t, state = group()) {
  const fake = createFakeSupabase({ tables: { workspaces: [{ slug: "book-club-ab2cd", state, updated_at: "2026-09-26T10:00:00.000Z" }] } });
  t.after(installFakeSupabase(fake));
  return fake;
}

const page = async (query) => {
  const response = mockResponse();
  await pageHandler({ method: "GET", query, headers: { host: "waddle.test", "x-forwarded-proto": "https" } }, response);
  return response.captured;
};

const meta = (html, property) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1];

test("a plan preview is its title and 'vote on a time', and nothing about the people or places", () => {
  const preview = previewFor(group(), { kind: "p" });
  assert.equal(preview.title, "Board games · vote on a time");
  assert.equal(preview.action, "Vote on a time");
  const text = JSON.stringify(preview);
  for (const name of NAMES) assert.ok(!text.includes(name), `the preview mentions ${name}`);
  const picked = previewFor(group({ plan: { ...group().plan, chosen: "2026-10-04T22:00:00.000Z" } }), { kind: "p" });
  assert.equal(picked.title, "Board games · RSVP", "once a time is picked the link asks for RSVPs, not votes");
  assert.equal(picked.action, "RSVP");
  assert.equal(previewFor(group(), { kind: "g" }).title, "Book club · find a time on Waddle");
  assert.equal(previewFor(group({ plan: null }), { kind: "p" }).headline, "Book club", "a plan link without a plan falls back to the group");
  assert.equal(cleanText("a\n\tb c   d"), "a b c d");
});

test("the /p/ page carries Open Graph and Twitter tags for the plan, with no names leaking", async (t) => {
  withDb(t);
  const { status, headers, body } = await page({ kind: "p", slug: "book-club-ab2cd", i: CODE });
  assert.equal(status, 200);
  assert.match(headers["Content-Type"], /text\/html/);
  assert.equal(headers["X-Robots-Tag"], "noindex");
  assert.equal(meta(body, "og:title"), "Board games · vote on a time");
  assert.equal(meta(body, "twitter:title"), "Board games · vote on a time");
  assert.equal(meta(body, "twitter:card"), "summary_large_image");
  assert.equal(meta(body, "og:url"), `https://waddle.test/p/book-club-ab2cd?i=${CODE}`);
  assert.equal(meta(body, "og:image"), `https://waddle.test/api/og?kind=p&amp;slug=book-club-ab2cd&amp;i=${CODE}`);
  assert.match(meta(body, "og:description"), /never what anyone's doing|never what anyone&#39;s doing/);
  assert.match(body, /<title>Board games · vote on a time<\/title>/);
  assert.equal((body.match(/property="og:title"/g) || []).length, 1, "the default preview block is replaced, not repeated");
  const head = body.slice(0, body.indexOf("</head>"));
  for (const name of NAMES) assert.ok(!head.includes(name), `the page's head mentions ${name}`);
  assert.match(body, /<script type="module" src="\/app\.js"><\/script>/, "still the app for people who open it");
});

test("without the live invite code a link shows only the generic Waddle preview", async (t) => {
  withDb(t, group({ invite: { code: CODE, revoked: true } }));
  for (const query of [{ kind: "p", slug: "book-club-ab2cd", i: CODE }, { kind: "p", slug: "book-club-ab2cd" }, { kind: "g", slug: "nope-00000", i: CODE }]) {
    const { body } = await page(query);
    assert.equal(meta(body, "og:title"), GENERIC_PREVIEW.title, JSON.stringify(query));
    const head = body.slice(0, body.indexOf("</head>"));
    assert.ok(!head.includes("Board games"));
    assert.ok(!head.includes("Book club"));
  }
});

test("the card image is a PNG drawn from the preview text only", async (t) => {
  withDb(t);
  const response = mockResponse();
  await ogHandler({ method: "GET", query: { kind: "p", slug: "book-club-ab2cd", i: CODE }, headers: {} }, response);
  assert.equal(response.captured.status, 200);
  assert.equal(response.captured.headers["Content-Type"], "image/png");
  const png = response.captured.body;
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, "1200x630");
  const tree = JSON.stringify(cardFor(previewFor(group(), { kind: "p" })));
  assert.match(tree, /Board games/);
  assert.match(tree, /Vote on a time/);
  for (const name of NAMES) assert.ok(!tree.includes(name));
  assert.ok(headlineSize("x".repeat(70)) < headlineSize("short"), "long titles get smaller type");
});

test("the static fallback card exists at 1200x630", async () => {
  const { readFileSync } = await import("node:fs");
  const png = readFileSync(new URL("../icons/og-card.png", import.meta.url));
  assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, "1200x630");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /og:image" content="https:\/\/[^"]+\/icons\/og-card\.png"/, "the home page has the generic card");
});

test("withPreview escapes what it puts into the page", () => {
  const html = withPreview('<title>x</title><meta name="description" content="d" /><!-- preview --><!-- /preview -->', { title: '"><script>', description: "<b>", headline: "h", action: "a" }, { url: "u", image: "i" });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});
