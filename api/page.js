// Shareable links with link previews.
//
//   /g/<group>?i=<invite code>   the group      (vercel.json rewrites both here)
//   /p/<group>?i=<invite code>   its plan
//
// Answers with the app's own index.html plus Open Graph and Twitter tags, so a
// link pasted into a group chat shows "<Plan> · vote on a time" and a card
// (api/og.js). People who open it get the normal app, which moves itself to
// /?w=<group>&i=<code>. See api/_preview.js for what a preview may contain.

import { readFile } from "node:fs/promises";
import { GENERIC_PREVIEW, loadPreview, originOf, queryOf } from "./_preview.js";

let cachedIndex = null;

async function indexHtml(origin) {
  if (cachedIndex) return cachedIndex;
  try {
    cachedIndex = await readFile(new URL("../index.html", import.meta.url), "utf8");
  } catch {
    // Not bundled with the function: read the static page from this deployment.
    const response = await fetch(`${origin}/`);
    cachedIndex = await response.text();
  }
  return cachedIndex;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

/** index.html with this link's title and preview tags. */
export function withPreview(html, preview, { url, image }) {
  const tags = [
    `<meta name="robots" content="noindex" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Waddle" />`,
    `<meta property="og:title" content="${escapeHtml(preview.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(preview.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escapeHtml(`${preview.headline}. ${preview.action} on Waddle.`)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(preview.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(preview.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ].join("\n    ");
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(preview.title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtml(preview.description)}" />`)
    .replace(/<!-- preview[\s\S]*?<!-- \/preview -->/, tags);
}

export default async function handler(request, response) {
  const origin = originOf(request);
  const { kind, slug, invite } = queryOf(request);
  let preview;
  try {
    preview = await loadPreview({ slug, invite, kind });
  } catch {
    preview = { ...GENERIC_PREVIEW };
  }
  const code = invite ? `?i=${encodeURIComponent(invite)}` : "";
  const url = slug ? `${origin}/${kind}/${slug}${code}` : `${origin}/`;
  const image = `${origin}/api/og?kind=${kind}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}${invite ? `&i=${encodeURIComponent(invite)}` : ""}`;
  let html;
  try {
    html = await indexHtml(origin);
  } catch {
    response.setHeader("Location", `/${slug ? `?w=${encodeURIComponent(slug)}${invite ? `&i=${encodeURIComponent(invite)}` : ""}` : ""}`);
    return response.status(302).end();
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  // Short, so turning a link off (or renaming a plan) shows up in new previews quickly.
  response.setHeader("Cache-Control", "public, max-age=0, s-maxage=120");
  response.setHeader("X-Robots-Tag", "noindex");
  return response.status(200).end(withPreview(html, preview, { url, image }));
}
