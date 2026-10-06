"use client";

import { AnimatePresence, m } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import { Button } from "@/components/ui/Button";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import { useBalances, useDevConfig, usePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { formatUsdc } from "@/lib/format";
import {
  parseDraft,
  validateAmountStep,
  validateRiskStep,
  validateTermsStep,
  type DraftErrors,
} from "@/lib/offer-validation";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import { DevnetLoanService } from "@/lib/devnet-loan-service";
import { SharkyTip } from "@/components/brand/SharkyTip";
import { OfferPreview } from "./OfferPreview";
import { StepAmount } from "./StepAmount";
import { StepReview } from "./StepReview";
import { StepRisk } from "./StepRisk";
import { StepTerms } from "./StepTerms";
import { useDraft } from "./useDraft";
import styles from "./CreateWizard.module.css";

const STEPS = [
  { title: "Amount", question: "How much USDC will you lend?" },
  {
    title: "Rate and term",
    question: "What does the borrower pay, and for how long?",
  },
  { title: "Collateral", question: "How much wSOL secures the loan?" },
  { title: "Review", question: "Check the terms, then lock your USDC." },
] as const;

const TIPS = [
  "Lend only what you can leave locked for the whole term.",
  "The interest is the cost of the whole term, not a yearly rate.",
  "Collateral is what you keep if the borrower never repays.",
  "This preview is exactly what borrowers will read.",
] as const;

type Created = {
  href: string;
  principal: bigint;
  draft: ReturnType<typeof useDraft>["draft"];
  owed: bigint | null;
};

export function CreateWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const requestedStep = Number(params.get("step") || 1);
  const step =
    Number.isInteger(requestedStep) && requestedStep >= 1 && requestedStep <= 4
      ? requestedStep
      : 1;
  const heading = useRef<HTMLHeadingElement>(null);
  const [direction, setDirection] = useState(1);
  const { price } = usePrice();
  const { config } = useDevConfig();
  const { signer, publicKey, setConnectOpen, bumpRefresh } = useSigner();
  const balances = useBalances(publicKey, config);
  const toast = useToast();
  const { draft, update, reset, owed, principal, hydrated } = useDraft(price);
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [touched, setTouched] = useState(false);

  const stepErrors: DraftErrors[] = [
    validateAmountStep(draft),
    validateTermsStep(draft),
    validateRiskStep(draft),
    {},
  ];
  const valid = (n: number) =>
    stepErrors.slice(0, n).every((e) => Object.keys(e).length === 0);
  const errors = touched ? stepErrors[step - 1] : {};

  const go = useCallback(
    (n: number) => {
      setDirection(n > step ? 1 : -1);
      setTouched(false);
      setError(null);
      router.replace(n === 1 ? "/devnet/create" : `/devnet/create?step=${n}`, {
        scroll: false,
      });
    },
    [router, step]
  );

  // A deep link past an invalid step falls back to the first step that needs attention.
  useEffect(() => {
    if (!hydrated || (draft.collateralMode === "auto" && !price)) return;
    for (let n = 1; n < step; n++) if (!valid(n)) return go(n);
    heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, step, draft.collateralMode, price]);

  const next = () => {
    setTouched(true);
    if (!valid(step)) return;
    if (step < 4) go(step + 1);
  };

  const lock = async () => {
    setError(null);
    if (!signer || !publicKey) {
      setConnectOpen(true);
      return;
    }
    const parsed = parseDraft(draft);
    if (!parsed || !config) {
      setError(
        config
          ? "Some terms are out of range. Go back and check them."
          : "Network configuration is unavailable. Retry the connection above."
      );
      return;
    }
    if (balances && balances.usdc < parsed.principal) {
      setError(
        `You hold ${formatUsdc(
          balances.usdc
        )} USDC. Lend less, or fund this wallet.`
      );
      return;
    }
    setBusy(true);
    try {
      const result = await new DevnetLoanService(signer, config).execute({
        action: "create",
        draft,
      });
      const offerId = "offerId" in result ? result.offerId : undefined;
      if (!offerId)
        throw new Error("The confirmed offer identifier is unavailable.");
      setSignature(result.signature ?? null);
      setCreated({
        href: `/devnet/offers/${publicKey.toBase58()}/${offerId}`,
        principal: parsed.principal,
        draft,
        owed,
      });
      toast({
        tone: "success",
        title: "Offer is live",
        detail: `You locked ${formatUsdc(parsed.principal)} USDC.`,
      });
      bumpRefresh();
      reset();
    } catch (e) {
      setError(
        e instanceof SubmissionError ? e.message : messageFromAnchorError(e)
      );
      if (e instanceof SubmissionError && e.signature)
        setSignature(e.signature);
    } finally {
      setBusy(false);
    }
  };

  const current = STEPS[step - 1];

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.progress}>
          <LogoMark size={36} progress={created ? 1 : (step - 1) / 4 + 0.08} />
          <div>
            <p className={styles.kicker}>
              {created ? "Done" : `Step ${step} of 4 · ${current.title}`}
            </p>
            <ol className={styles.dots} aria-label="Steps">
              {STEPS.map((s, i) => {
                const n = i + 1;
                const reachable = n < step || valid(n - 1);
                return (
                  <li key={s.title}>
                    <button
                      type="button"
                      className={styles.dot}
                      data-state={
                        created || n < step
                          ? "done"
                          : n === step
                          ? "current"
                          : "todo"
                      }
                      aria-current={n === step ? "step" : undefined}
                      aria-label={`${s.title}${n < step ? ", done" : ""}`}
                      disabled={Boolean(created) || !reachable || n === step}
                      onClick={() => go(n)}
                    >
                      {s.title}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false} custom={direction}>
          {created ? (
            <m.section
              key="done"
              className={styles.done}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className={styles.question}>Your offer is live</h1>
              <p className={styles.moved}>
                You locked{" "}
                <span className="num">{formatUsdc(created.principal)}</span>{" "}
                USDC. It waits in the offer&apos;s vault until a borrower takes
                it, or you cancel.
              </p>
              <div className={styles.doneActions}>
                <Link href={created.href} className={styles.primaryLink}>
                  View offer
                </Link>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCreated(null);
                    go(1);
                  }}
                >
                  Create another
                </Button>
              </div>
            </m.section>
          ) : (
            <m.section
              key={step}
              custom={direction}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: 16 * d }),
                center: { opacity: 1, x: 0 },
                exit: (d: number) => ({ opacity: 0, x: -12 * d }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className={styles.stepBody}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  step < 4 &&
                  (e.target as HTMLElement).tagName !== "BUTTON"
                ) {
                  e.preventDefault();
                  next();
                }
              }}
            >
              <h1 ref={heading} tabIndex={-1} className={styles.question}>
                {current.question}
              </h1>
              {step === 1 && (
                <StepAmount
                  draft={draft}
                  update={update}
                  errors={errors}
                  balance={balances?.usdc ?? null}
                  onEnter={next}
                />
              )}
              {step === 2 && (
                <StepTerms
                  draft={draft}
                  update={update}
                  errors={errors}
                  principal={principal}
                  owed={owed}
                />
              )}
              {step === 3 && (
                <StepRisk
                  draft={draft}
                  update={update}
                  errors={errors}
                  price={price}
                  owed={owed}
                />
              )}
              {step === 4 && (
                <StepReview
                  draft={draft}
                  owed={owed}
                  price={price}
                  onEdit={go}
                />
              )}

              <div className={styles.footer}>
                {step > 1 ? (
                  <Button variant="ghost" onClick={() => go(step - 1)}>
                    Back
                  </Button>
                ) : (
                  <span />
                )}
                {step < 4 ? (
                  <Button size="lg" onClick={next}>
                    Continue
                  </Button>
                ) : (
                  <Button size="lg" loading={busy} onClick={lock}>
                    {busy
                      ? "Waiting for wallet and chain…"
                      : signer
                      ? "Lock USDC"
                      : "Connect to lock USDC"}
                  </Button>
                )}
              </div>
              <AnimatePresence>
                {error && (
                  <m.p
                    role="alert"
                    className={styles.error}
                    initial={{ opacity: 0, x: 0 }}
                    animate={{ opacity: 1, x: [0, -4, 4, -2, 0] }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.32 }}
                  >
                    {error}
                  </m.p>
                )}
              </AnimatePresence>
            </m.section>
          )}
        </AnimatePresence>
        {signature && (
          <a href={signatureUrl(signature)} target="_blank" rel="noreferrer">
            View transaction on Explorer ↗
          </a>
        )}
      </div>
      <aside
        className={styles.aside}
        aria-label="Borrower's view of this offer"
      >
        <OfferPreview
          draft={created?.draft ?? draft}
          owed={created ? created.owed : owed}
          price={price}
          live={Boolean(created)}
        />
        <SharkyTip>
          {created ? "Posted. Every term is on chain now." : TIPS[step - 1]}
        </SharkyTip>
      </aside>
    </div>
  );
}
