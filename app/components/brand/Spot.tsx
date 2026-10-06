import Image from "next/image";

const SPOTS = {
  waiting: "/illustrations/zl-spot-waiting.webp",
  notFound: "/illustrations/zl-spot-notfound.webp",
  private: "/illustrations/zl-spot-private.webp",
  success: "/illustrations/zl-spot-success.webp",
} as const;

export type SpotKind = keyof typeof SPOTS;

/**
 * A small pebble-on-water picture for empty, missing, private or done states.
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
  return (
    <Image
      className={className}
      src={SPOTS[kind]}
      width={size}
      height={size}
      alt=""
      aria-hidden
    />
  );
}
