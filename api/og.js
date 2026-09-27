// The link-preview image for a shared Waddle link: a 1200x630 PNG card with
// the plan's title (or the group's name) and "Vote on a time". Text comes from
// api/_preview.js, so it never holds member names, places or event names.
//
//   GET /api/og?kind=p&slug=<group>&i=<invite code>
//
// Drawn with @vercel/og (runs in plain Node, no build step) in the app's own
// fonts (api/_fonts, SIL Open Font License, see licenses/). If drawing fails
// for any reason, it redirects to the static card /icons/og-card.png.

import { readFile } from "node:fs/promises";
import { GENERIC_PREVIEW, loadPreview, queryOf } from "./_preview.js";

const COLORS = { bg: "#f4eee6", card: "#fffcf8", ink: "#231c17", muted: "#7b7068", accent: "#d4532e", line: "#e9e0d5" };

let fontsPromise = null;
function fonts() {
  fontsPromise ||= Promise.all([
    readFile(new URL("./_fonts/fraunces-latin-600-normal.woff", import.meta.url)),
    readFile(new URL("./_fonts/dm-sans-latin-600-normal.woff", import.meta.url)),
  ]).then(([fraunces, dmSans]) => [
    { name: "Fraunces", data: fraunces, weight: 600, style: "normal" },
    { name: "DM Sans", data: dmSans, weight: 600, style: "normal" },
  ]);
  return fontsPromise;
}

const h = (type, style, children) => ({ type, props: { style: { display: "flex", ...style }, children } });

/** Font size that keeps a headline to about three lines. */
export function headlineSize(text) {
  const length = String(text).length;
  if (length <= 22) return 92;
  if (length <= 40) return 76;
  if (length <= 60) return 62;
  return 52;
}

/** The card as a satori element tree. */
export function cardFor(preview) {
  const headline = preview.headline.length > 80 ? `${preview.headline.slice(0, 79)}…` : preview.headline;
  return h("div", { width: "100%", height: "100%", display: "flex", padding: 44, background: COLORS.bg, fontFamily: "DM Sans" }, [
    h("div", {
      display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%",
      padding: "56px 64px", borderRadius: 44, background: COLORS.card, border: `2px solid ${COLORS.line}`,
    }, [
      h("div", { display: "flex", alignItems: "center", gap: 16 }, [
        h("div", { width: 22, height: 22, borderRadius: 11, background: COLORS.accent }, []),
        h("div", { fontFamily: "Fraunces", fontSize: 40, color: COLORS.ink, letterSpacing: -0.5 }, "waddle"),
      ]),
      h("div", { display: "flex", fontFamily: "Fraunces", fontSize: headlineSize(headline), lineHeight: 1.08, color: COLORS.ink, letterSpacing: -1.5 }, headline),
      h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        h("div", { display: "flex", padding: "18px 34px", borderRadius: 999, background: COLORS.accent, color: "#fff", fontSize: 34 }, `${preview.action} →`),
        h("div", { display: "flex", fontSize: 24, color: COLORS.muted }, "Busy or free, never what you're doing"),
      ]),
    ]),
  ]);
}

/** PNG bytes for a preview. */
export async function renderCard(preview) {
  const { ImageResponse } = await import("@vercel/og");
  const image = new ImageResponse(cardFor(preview), { width: 1200, height: 630, fonts: await fonts() });
  return Buffer.from(await image.arrayBuffer());
}

export default async function handler(request, response) {
  try {
    const { kind, slug, invite } = queryOf(request);
    const preview = await loadPreview({ slug, invite, kind }).catch(() => ({ ...GENERIC_PREVIEW }));
    const png = await renderCard(preview);
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    return response.status(200).end(png);
  } catch (error) {
    console.error("og image failed:", error);
    response.setHeader("Location", "/icons/og-card.png");
    response.setHeader("Cache-Control", "no-store");
    return response.status(302).end();
  }
}
