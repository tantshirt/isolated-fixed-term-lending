# Onboarding an operator

One guided session, about 30 minutes, after the interview. After this session you stop helping; see [observation-checklist.md](observation-checklist.md).

## Before the session

- Confirm which flows are live on the production deployment. Open only those to the participant; the rest stay hidden behind their capability flags.
- Prepare Devnet SOL and Devnet USDC for the participant's wallet. Test assets only.
- Have the comprehension check ready.

## Session

1. **Network.** Say that this is Solana Devnet with test assets, that nothing has real value, and that the cash-out sandbox never pays real cash.
2. **Wallet.** The participant connects their own wallet. ZenLo has no account sign-up; the wallet is the identity. Never ask for a seed phrase or private key.
3. **Test funds.** Send the prepared Devnet SOL and USDC. Show the balances in their wallet.
4. **Private sign-in.** Open Private and sign the private sign-in message. Explain that the signature proves wallet ownership and moves no funds.
5. **Desk.** Create a desk (once Epic 23 ships) or a private room (until then). Set the desk policy together, reading each field aloud: assets, principal, annual pricing ceiling, duration, repayment mode, LTV, grace, fees and auditors.
6. **Invite.** Invite a second participant or a borrower with the room invite, using the existing invites and join requests. No other invite system.
7. **Explain authority.** Every loan is funded from the lender's own wallet, never a shared treasury. The desk administrator cannot spend a lender's funds or read a loan without being part of it.
8. **Explain recovery.** Walk through the timeline on one loan: maturity, grace end, priced recovery and the final whole-collateral claim seven days after grace. The final claim can lose the borrower's surplus.
9. **Comprehension check.** Ask the five questions in [comprehension-check.md](comprehension-check.md) and record the answers.

## After the session

- Log the participant's alias, desk id, wallets and onboarding date.
- From here on, any help you give makes the next loan **assisted**.
