import Link from "next/link";
import { Sharky } from "@/components/brand/Sharky";
import list from "@/components/offers/OffersPage.module.css";
import styles from "./Discover.module.css";

/** Private lenders have no public listing. Say so, and show where they do act. */
export function LenderPrivateEmpty({ onSeeCards }: { onSeeCards: () => void }) {
  return (
    <div className={`${list.empty} ${styles.explainer}`}>
      <Sharky pose="detective" size={104} />
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
