import s from "./PoweredByMagicBlock.module.css";

/**
 * Credit for the private rollup. Official MagicBlock logo (see public/brands/SOURCES.md),
 * black on light surfaces and white on navy, with the clear space their brand page asks for.
 */
export function PoweredByMagicBlock({ tone = "light" }: { tone?: "light" | "navy" }) {
  return (
    <a
      className={s.badge}
      data-tone={tone}
      href="https://www.magicblock.xyz"
      target="_blank"
      rel="noreferrer"
    >
      <span className={s.label}>Private rollup powered by</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={tone === "navy" ? "/brands/magicblock-white.svg" : "/brands/magicblock-black.svg"}
        alt="MagicBlock"
        width={113}
        height={22}
      />
    </a>
  );
}
