import s from "./Spot.module.css";

/** Badge glyph drawn in the lower-right disc, in a 24px box. */
const GLYPHS = {
  plus: <path d="M12 6v12M6 12h12" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5" />
      <path d="m14.5 14.5 4 4" />
    </>
  ),
  check: <path d="m6.5 12.5 3.5 3.5 7.5-8" />,
  lock: (
    <>
      <rect x="6.5" y="11" width="11" height="8" rx="2" />
      <path d="M9 11V9a3 3 0 0 1 6 0v2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 8.5V12l2.5 1.5" />
    </>
  ),
} as const;

const SPOTS = {
  /** Nothing yet: rows that will fill in. */
  waiting: { glyph: "clock", rows: "ghost" },
  /** No open offers: the shape of an offer row, waiting for one. */
  offers: { glyph: "plus", rows: "coin" },
  /** No requests: the shape of a request row. */
  requests: { glyph: "plus", rows: "ghost" },
  /** Discover guide: rows being browsed. */
  discover: { glyph: "search", rows: "coin" },
  notFound: { glyph: "search", rows: "ghost" },
  private: { glyph: "lock", rows: "redacted" },
  success: { glyph: "check", rows: "coin" },
} as const;

export type SpotKind = keyof typeof SPOTS;

/**
 * A small outline of ZenLo's own list rows for empty, missing, private or done states.
 * Decoration only: never inside a figure readout, risk warning or signing control.
 */
export function Spot({
  kind,
  size = 120,
  className,
}: {
  kind: SpotKind;
  size?: number;
  className?: string;
}) {
  const spot = SPOTS[kind];
  const navy = spot.rows === "redacted";
  return (
    <svg
      className={`${s.spot} ${className ?? ""}`}
      data-tone={navy ? "navy" : undefined}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      aria-hidden
      focusable="false"
    >
      <rect className={s.tile} x="2" y="2" width="116" height="116" rx="30" />
      {/* First row is a filled card; the two behind it are dashed placeholders. */}
      <rect className={s.row} x="18" y="24" width="84" height="22" rx="11" />
      {spot.rows === "coin" && <circle className={s.coin} cx="30" cy="35" r="6" />}
      <rect className={s.line} x={spot.rows === "coin" ? 41 : 28} y="32" width="30" height="6" rx="3" />
      {spot.rows === "redacted" ? (
        <rect className={s.redact} x="76" y="32" width="16" height="6" rx="3" />
      ) : (
        <rect className={s.lineSoft} x="80" y="32" width="12" height="6" rx="3" />
      )}
      <rect className={s.ghost} x="18" y="54" width="84" height="22" rx="11" />
      <rect className={s.ghost} x="18" y="84" width="58" height="22" rx="11" />
      <circle className={s.badge} cx="94" cy="94" r="16" />
      <g className={s.glyph} transform="translate(82 82)">
        {GLYPHS[spot.glyph]}
      </g>
    </svg>
  );
}
