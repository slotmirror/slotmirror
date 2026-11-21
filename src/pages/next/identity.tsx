import { ACCOUNT_COLORS } from "../../colors";
import type { Provider } from "../../config";
import type { EditorAccount, Level } from "../../editor";

/**
 * Identity and provider, kept apart. A calendar's identity is its colour, shown as a small swatch
 * before its name. The provider is a monochrome mark in the text colour, shown only where the
 * provider matters. A provider mark is never tinted: Microsoft and Google allow only their own
 * colours or neutral monochrome, and a tinted mark reads as another brand's logo.
 *
 * The components carry the presentation they need as SVG attributes and inline styles (the CSP
 * allows inline styles), so they render the same on every page without page CSS. Pages can still
 * reach them through the classes `cal-swatch`, `pglyph` and `lmark` (`.swatch` is the colour picker's).
 */

/** The CSS custom property `--c` that carries a calendar's colour into an inline style. */
export function chipStyle(color: EditorAccount["color"]): string {
  return `--c:${ACCOUNT_COLORS[color]}`;
}

/**
 * The calendar's colour as a fill, lifted towards white in dark mode. Mixed in oklab: a hue mix in
 * oklch with a neutral drifts through other hues.
 */
export const LIFTED = "color-mix(in oklab, var(--c), light-dark(var(--c), white) 38%)";

/**
 * A 10 x 10 px swatch with a 3 px radius in the calendar's colour. With `label` it is an image with
 * that accessible name; without it, it is decorative and the name beside it carries the meaning.
 */
export function CalendarSwatch(props: {
  account: Pick<EditorAccount, "color">;
  /** Accessible name, for a swatch that stands alone. */
  label?: string;
}) {
  return (
    <svg
      class="cal-swatch"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={chipStyle(props.account.color)}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <rect width="10" height="10" rx="3" style={`fill:${LIFTED}`} />
    </svg>
  );
}

const PROVIDER_NAMES: Record<Provider, string> = {
  microsoft: "Microsoft 365",
  google: "Google Calendar",
};

/**
 * The provider's mark in one neutral colour (`currentColor`), 14 px, drawn on whole pixels. Meant
 * for `--text-3`. With `label` it is an image with that name (pass `true` for the product name);
 * without it, it is decorative.
 */
export function ProviderGlyph(props: { provider: Provider; label?: string | true }) {
  const label = props.label === true ? PROVIDER_NAMES[props.provider] : props.label;
  const a11y = {
    role: label ? "img" : undefined,
    "aria-label": label,
    "aria-hidden": label ? undefined : ("true" as const),
  };
  if (props.provider === "microsoft") {
    // Four squares of 6 px with a 1 px gap: the proportions of the mark, snapped to the grid.
    return (
      <svg class="pglyph" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" {...a11y}>
        <path d="M0.5 0.5h6v6h-6zM7.5 0.5h6v6h-6zM0.5 7.5h6v6h-6zM7.5 7.5h6v6h-6z" />
      </svg>
    );
  }
  return (
    <svg class="pglyph" width="14" height="14" viewBox="0 0 48 48" fill="currentColor" {...a11y}>
      <path d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** What the block of a level holds, and whether a lock says that only the user sees it. */
type MarkFill = "none" | "hatch" | "title" | "full";

/**
 * One entry per level. A new level, such as a private "busy", adds one entry here; the compiler
 * asks for it because the record is keyed by `Level`.
 */
const MARKS: Record<Level, { fill: MarkFill; lock: boolean }> = {
  off: { fill: "none", lock: false },
  "busy-private": { fill: "hatch", lock: true },
  "busy-open": { fill: "hatch", lock: false },
  "title-private": { fill: "title", lock: true },
  "title-open": { fill: "title", lock: false },
  "full-private": { fill: "full", lock: true },
  "full-open": { fill: "full", lock: false },
};

/*
 * Geometry on a 16 px grid. Strokes are 1 px on half-pixel coordinates, so each straight edge
 * covers exactly one row or column of pixels at 1x and two at 2x. The frame spans pixels 1 to 14
 * across and 2 to 13 down; its inside is columns 2 to 13 and rows 3 to 12. The hatch is three
 * 45-degree lines through pixel centres, 4 px apart, centred on the block, with 1 px of air to the
 * frame. Lines of text sit on rows 5, 8 and 11.
 */
const HATCH = [
  { x1: 3.5, y1: 8.5, x2: 7.5, y2: 4.5 },
  { x1: 4.5, y1: 11.5, x2: 11.5, y2: 4.5 },
  { x1: 8.5, y1: 11.5, x2: 12.5, y2: 7.5 },
] as const;

const TEXT_LINES: Record<"title" | "full", readonly { y: number; x2: number }[]> = {
  title: [{ y: 5.5, x2: 12 }],
  full: [
    { y: 5.5, x2: 12 },
    { y: 8.5, x2: 12 },
    { y: 11.5, x2: 8 },
  ],
};

/**
 * A 16 px mark of what a copy carries: dashed outline (not copied), hatched block (busy only),
 * block with one line (title), block with three lines (everything), and a small lock when only
 * the user sees the details. `tint` colours the content of the block (hatch or lines) in a
 * calendar's colour, usually the source's; the frame stays in the text colour. The lock is
 * knocked out of the block with `--glyph-ring`, the background behind the mark. Pass `label` to
 * give the mark an accessible name; without it the text beside it must carry the meaning.
 */
export function LevelMark(props: { level: Level; tint?: EditorAccount["color"]; label?: string }) {
  const mark = MARKS[props.level];
  const ink = props.tint ? LIFTED : "currentColor";
  const ring = "var(--glyph-ring, var(--surface, Canvas))";
  return (
    <svg
      class="lmark"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={props.tint ? `flex:none;${chipStyle(props.tint)}` : "flex:none"}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      data-level={props.level}
    >
      {mark.fill === "none" ? (
        <g class="lmark-frame" stroke="currentColor" stroke-width="1">
          {/* A dash pattern on the rounded rect lands between pixels and turns grey at 1x. Solid
              corners and dashes on whole pixels stay sharp: 2 px dashes, symmetric per side. */}
          <path d="M1.5 4.5a2 2 0 0 1 2-2M12.5 2.5a2 2 0 0 1 2 2M14.5 11.5a2 2 0 0 1-2 2M3.5 13.5a2 2 0 0 1-2-2" />
          <path
            shape-rendering="crispEdges"
            d="M5 2.5h2M9 2.5h2M5 13.5h2M9 13.5h2M1.5 7v2M14.5 7v2"
          />
        </g>
      ) : (
        <rect
          class="lmark-frame"
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="2"
          stroke="currentColor"
          stroke-width="1"
          shape-rendering="crispEdges"
        />
      )}
      {mark.fill === "hatch" ? (
        <g style={`stroke:${ink}`} stroke-width={props.tint ? "1.25" : "1.1"}>
          {HATCH.map((line) => (
            <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
          ))}
        </g>
      ) : null}
      {mark.fill === "title" || mark.fill === "full" ? (
        <g style={`stroke:${ink}`} stroke-width="1">
          {TEXT_LINES[mark.fill].map((line) => (
            <line x1="4" y1={line.y} x2={line.x2} y2={line.y} />
          ))}
        </g>
      ) : null}
      {mark.lock ? (
        <g class="lmark-lock">
          {/* A 1 px outline, as light as the frame: a solid lock was a blob that drowned the
              hatch. Under it a 1 px knock-out in the background colour (3 px stroke) and a body
              filled with it, so the lock reads on top of the block. Body: pixels 10 to 15 across,
              10 to 14 down; shackle up to row 7. */}
          <path
            d="M10.5 10.5h5v4h-5zM11.5 10.5V9a1.5 1.5 0 0 1 3 0v1.5"
            style={`stroke:${ring};fill:${ring}`}
            stroke-width="3"
            stroke-linejoin="round"
          />
          <rect
            x="10.5"
            y="10.5"
            width="5"
            height="4"
            rx="1"
            stroke="currentColor"
            stroke-width="1"
          />
          <path d="M11.5 10.5V9a1.5 1.5 0 0 1 3 0v1.5" stroke="currentColor" stroke-width="1" />
        </g>
      ) : null}
    </svg>
  );
}
