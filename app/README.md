# Lendspan interface

Next.js 15 / React 19 interface for the isolated loan program.

```sh
npm install
cp .env.example .env.local
npm run dev
```

- `/`: public landing page; no sign-in.
- `/demo`: wallet-free, browser-local simulation. Reset, switch roles, edit terms, and replay all outcomes.
- `/devnet`: real Devnet offers, wallet signing, funding guidance, wrapping, and Pyth refresh.

Read [Devnet setup](../docs/devnet.md) before chain transactions. Public environment values are compiled into the bundle; rebuild after changing them. No private keys belong in environment files or the frontend.

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
npm start
```

Use `NEXT_BUILD_DIR=.next-review` for an isolated build and its matching server when another development server is running. Do not run builds and development against the same output directory.

The visual contract is [design and experience](../docs/design-and-experience.md): light surfaces, blue actions, Inter typography, semantic CSS tokens, keyboard access, and reduced-motion support. The adapted council is in [`.design-council`](../.design-council/README.md).

Local validator controls require explicit localnet configuration, nonproduction execution, and loopback requests. They are never available on production Devnet pages.
