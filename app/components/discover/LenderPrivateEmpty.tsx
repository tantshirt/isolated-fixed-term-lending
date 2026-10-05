import Link from "next/link";
import list from "@/components/offers/OffersPage.module.css";
import styles from "./Discover.module.css";

/** Private lenders have no public listing. Say so, and show where they do act. */
export function LenderPrivateEmpty({ onSeeCards }: { onSeeCards: () => void }) {
  return (
    <div className={`${list.empty} ${styles.explainer}`}>
      <span className={styles.lock} aria-hidden>
        <svg width="22" height="22" viewBox="0 0 22 22">
          <rect x="4" y="9.5" width="14" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7.5 9.5V7a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      <p className={list.emptyTitle}>Private lenders stay unlisted</p>
      <p className={list.emptyBody}>
        A private lender&apos;s money and terms live inside a sealed room, so there is nothing public to list. They find
        borrowers from the cards on the other side, ask to join, and propose terms only that borrower can read.
      </p>
      <div className={styles.explainerActions}>
        <button type="button" className={`${list.emptyLink} ${styles.linkButton}`} onClick={onSeeCards}>
          See private borrower cards
        </button>
        <Link href="/devnet/private" className={list.emptyLink}>
          Open a private room
        </Link>
      </div>
    </div>
  );
}
