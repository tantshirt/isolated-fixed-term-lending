import type { ActingRole } from "@/lib/constants";
import styles from "./Avatar.module.css";

const ROLE_INITIAL: Record<ActingRole, string> = { lender: "L", borrower: "B", liquidator: "X" };

/** A quiet, deterministic badge: the arc angle comes from the address. */
export function Avatar({ seed, role, size = 32 }: { seed: string; role?: ActingRole | null; size?: number }) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const angle = h % 360;
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, ["--a" as string]: `${angle}deg`, fontSize: size * 0.4 }}
      aria-hidden
    >
      {role ? ROLE_INITIAL[role] : ""}
    </span>
  );
}
