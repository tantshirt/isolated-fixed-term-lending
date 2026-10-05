# Lendspan landing-page artwork

Generated through Kie with `gpt-image-2-5-sunburst-text-to-image` on 5 October 2026. The user approved abstract financial illustrations in Lendspan blue, one example loan as the story, and a $5 spending cap.

Three 2K images consumed **30 credits** (10 each), approximately **$0.15** at Kie's published $0.05 / 2K image pricing. Exact per-task receipts are in [generation-receipts.json](generation-receipts.json). No credentials are stored in these files.

- [Bridge](../../app/public/illustrations/lendspan-bridge.webp): the agreement connects two parties.
- [Collateral](../../app/public/illustrations/lendspan-collateral.webp): one asset held separately during the loan.
- [Return](../../app/public/illustrations/lendspan-return.webp): the agreement completes and assets return.

The site serves optimized WebP files (about 76 KB combined). Full-resolution originals are preserved in `originals/`. The exact prompt set is in [image-prompts.json](image-prompts.json), adapted from the Desktop `VIDEOS/manticore/brand/prompt-craft/gpt-image.md` guide: objective first, explicit composition and counts, consistent materials/palette, motion-friendly margins, no unintended text or logos.

Images are illustrative metaphors. Loan amounts, terms, asset logos, and risks remain accessible HTML rather than generated image text. The existing Lendspan typography and colors are preserved.

Sources: [Kie model and pricing](https://kie.ai/gpt-image-2-5), [Sunburst text-to-image API](https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-text-to-image).

## Private lending series (5 October 2026)

Five more 2K images in the same family, made with the same model through `app/scripts/generate-art.mjs` (prompts in [image-prompts-private.json](image-prompts-private.json)). They used 50 credits, about $0.25:

- [Private room](../../app/public/illustrations/lendspan-private-room.webp): two parties inside one protected space.
- [Negotiate](../../app/public/illustrations/lendspan-negotiate.webp): two sides adjusting the same agreement.
- [Settle quietly](../../app/public/illustrations/lendspan-settle-quietly.webp): only one balance leaves the private space.
- [Competing offers](../../app/public/illustrations/lendspan-competing-offers.webp): three lenders who cannot see each other.
- [Open liquidation](../../app/public/illustrations/lendspan-open-liquidation.webp): a liquidator sees only a slot, never the loan.

The script reads `KIE_API_KEY` from gitignored `app/.env.local`, caps a run at 100 credits, and reuses an existing original instead of paying again.
