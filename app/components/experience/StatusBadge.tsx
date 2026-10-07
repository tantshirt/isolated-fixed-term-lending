import { featureStatus, STATUS_LABEL, type FeatureId } from "@/lib/feature-status";
import s from "./StatusBadge.module.css";

/** Honest availability next to a feature: live on Devnet, gated pilot, or the provider's sandbox. */
export function StatusBadge({ feature }: { feature: FeatureId }) {
  const status = featureStatus(feature);
  return (
    <span className={s.badge} data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}
