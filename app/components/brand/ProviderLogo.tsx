import registry from "@/public/brands/registry.json";
import { PROVIDER_LOGOS, type ProviderLogoId } from "@/lib/provider-logos";
import s from "./ProviderLogo.module.css";

export type { ProviderLogoId };

/**
 * Official artwork from `public/brands/registry.json`, at its own proportions and colors. Use it
 * only beside the feature that uses that provider.
 */
export function ProviderLogo({
  id,
  height = 20,
  tone = "light",
}: {
  id: ProviderLogoId;
  height?: number;
  tone?: "light" | "navy";
}) {
  const logo = PROVIDER_LOGOS[id];
  const file = tone === "navy" && "navy" in logo ? logo.navy : logo.file;
  const entry = registry.assets.find((a) => a.file === file);
  if (!entry) return <span className={s.text}>{logo.name}</span>;
  const h = Math.round(height * ("scale" in logo ? logo.scale : 1));
  return (
    <span className={s.logo} data-tone={tone}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/brands/${file}`}
        alt={logo.mark ? "" : logo.name}
        height={h}
        width={Math.round(h * logo.ratio)}
        // Built-in clear space must not make the row taller than `height`.
        style={h > height ? { marginBlock: (height - h) / 2 } : undefined}
      />
      {logo.mark && <span className={s.text}>{logo.name}</span>}
    </span>
  );
}
