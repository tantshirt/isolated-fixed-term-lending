# Official brand assets

Downloaded on 2026-10-05 and hosted locally so icons do not depend on third-party requests. Artwork retains its original colors and proportions. Names and marks belong to their respective owners; their inclusion identifies assets and wallet choices, not an endorsement.

- USDC: `Token Logo/USDC Token.svg` from [Circle’s official USDC pack](https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/Pressroom/brandkit/logo-downloads/usdc.zip), linked by [Circle pressroom](https://www.circle.com/pressroom). This app uses USDC, not USDT.
- SOL/wSOL: [Solana official logomark](https://solana.com/src/img/branding/solanaLogoMark.svg), linked by [Solana branding](https://solana.com/branding). Wrapped SOL uses the SOL mark with an explicit wSOL label.
- MetaMask: [official fox SVG](https://images.ctfassets.net/clixtyxoaeas/4rnpEzy1ATWRKVBOLxZ1Fm/a74dc1eed36d23d7ea6030383a4d5163/MetaMask-icon-fox.svg), linked by [MetaMask brand assets](https://metamask.io/assets).
- Phantom: [official site icon](https://phantom.com/_web_platform_assets/favicon.svg), linked by [Phantom](https://phantom.com).
- Backpack: [official 128px icon](https://backpack.app/icon/128x128.png), linked by [Backpack](https://backpack.app/media-kit).
- Jupiter: [official site icon](https://jup.ag/favicon.svg), linked by [Jupiter Wallet](https://jup.ag/wallet).

Wallets discovered at runtime may provide their own Wallet Standard icon. Catalog assets identify the four requested brands even when an extension is not installed. Actual availability and Devnet/signing support determine connectability.
- MagicBlock: the full logo (wizard-hat icon and wordmark) from the header of [magicblock.xyz](https://www.magicblock.xyz), downloaded on 2026-10-06. The [MagicBlock press kit](https://www.magicblock.xyz/brand-asset-page) supplies black and white versions; `magicblock-white.svg` is the original file and `magicblock-black.svg` changes only the fill to black. Use the full logo, with clear space at least the height of the icon.

The machine-readable record, with file hashes and placements, is [`registry.json`](registry.json). `app/lib/brand-registry.test.ts` fails if a logo file changes without its entry.

Added on 2026-10-07 for the landing page and use cases (Story 19.7). Each appears only next to the feature that uses that provider:

- Pyth: `Pyth Logotype_Dark.svg` from the [Pyth logotype pack](https://legacy.pyth.network/brand-assets/pyth-logotype.zip), linked by [Pyth brand assets](https://legacy.pyth.network/brand). Keep clear space of at least the x-height.
- Squads: the header logo from [squads.xyz](https://squads.xyz). `squads-white.svg` is the original file; `squads-black.svg` changes only the fill to black for light surfaces.
- Convex: `Logos/SVG/logo-color.svg` from the [Convex logo pack](https://www.convex.dev/resources/logos.zip), linked by [Convex brand](https://www.convex.dev/brand).
- Vercel: the logomark from [Vercel brands](https://vercel.com/geist/brands), always shown with the word Vercel.
- Telegram: `Logo.svg` from the press pack on [Telegram's media page](https://telegram.org/tour/screenshots).
- MoneyGram: the horizontal color logo from the header of [corporate.moneygram.com](https://corporate.moneygram.com). The full brand center is [partner-gated](https://zeroheight.com/833c7683f/p/464181-brand-center); confirm usage with MoneyGram before mainnet.

Helius has no logo because nothing in the app uses Helius yet.

Added on 2026-10-07 for Story 26.6:

- Umbra: the logo mark from the header of [umbraprivacy.com](https://umbraprivacy.com) (`/assets/umbra-logo-mark.svg`), shown only beside the Shield wSOL panel and always with the word Umbra.
