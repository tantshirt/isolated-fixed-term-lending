import Image from "next/image";

const POSES = {
  guide: { src: "/illustrations/sharky-guide.webp", w: 800, h: 800 },
  waiting: { src: "/illustrations/sharky-waiting.webp", w: 800, h: 800 },
  clipboard: { src: "/illustrations/sharky-clipboard.webp", w: 800, h: 800 },
  confused: { src: "/illustrations/sharky-confused.webp", w: 800, h: 800 },
  detective: { src: "/illustrations/sharky-head-pi.webp", w: 512, h: 512 },
} as const;

export type SharkyPose = keyof typeof POSES;

/**
 * Sharky, the mascot, as decoration beside words that already say everything.
 * Never inside a figure readout, risk warning or signing control (council ruling).
 */
export function Sharky({
  pose,
  size = 120,
  className,
}: {
  pose: SharkyPose;
  size?: number;
  className?: string;
}) {
  const p = POSES[pose];
  return (
    <Image
      className={className}
      src={p.src}
      width={size}
      height={Math.round((size * p.h) / p.w)}
      alt=""
      aria-hidden
    />
  );
}
