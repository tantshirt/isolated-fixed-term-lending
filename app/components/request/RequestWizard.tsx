"use client";

import { AnimatePresence, m } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import { Tip } from "@/components/brand/Tip";
import { OfferPreview } from "@/components/create/OfferPreview";
import { StepAmount } from "@/components/create/StepAmount";
import { StepReview } from "@/components/create/StepReview";
import { StepRisk } from "@/components/create/StepRisk";
import { StepTerms } from "@/components/create/StepTerms";
import { useDraft } from "@/components/create/useDraft";
import { Button } from "@/components/ui/Button";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import { useBalances, useDevConfig, usePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { formatUsdc, formatWsol } from "@/lib/format";
import { parseDraft, validateAmountStep, validateRiskStep, validateTermsStep, type DraftErrors } from "@/lib/offer-validation";
import { RequestService } from "@/lib/request-service";
import { requestHref } from "@/lib/requests";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import { sendWrapSol } from "@/lib/transactions";
import styles from "@/components/create/CreateWizard.module.css";
import own from "./RequestWizard.module.css";
import { PrivateVenueScene, PublicVenueScene } from "@/components/experience/vignettes/Scenes";

const BASE = "/devnet/discover/request";
const DRAFT_KEY = "lendspan-devnet-request-draft-v1";

const STEPS = [
  { title: "Amount", question: "How much USDC do you want to borrow?" },
  { title: "Rate and term", question: "What will you pay, and for how long?" },
  { title: "Collateral", question: "How much wSOL will you lock?" },
  { title: "Review", question: "Check the terms, then post your request." },
] as const;

const TIPS = [
  "Ask for what you need. You repay it plus the full-term interest.",
  "Repaying early still costs the full-term interest.",
  "Collateral is what the lender keeps if you never repay.",
  "Lenders read exactly this before they fund.",
] as const;

type Posted = { href: string; principal: bigint; collateral: bigint };

/** Step 0 picks public or private; public continues through the four-step wizard. */
export function RequestWizard() {
  const params = useSearchParams();
  return params.get("venue") === "public" ? <PublicWizard /> : <ChooseVenue />;
}

function ChooseVenue() {
  return (
    <div className={own.choose}>
      <Link href="/devnet/discover" className={own.back}>
        ← Discover
      </Link>
      <h1 className={styles.question}>Where should lenders see your request?</h1>
      <p className={own.lede}>
        Both are fixed-term USDC loans against your wSOL, settled by the same rules. The difference is who can read the terms.
      </p>
      <div className={own.options}>
        <Link href={`${BASE}?venue=public`} className={own.option}>
          <div className={own.optionArt}>
            <PublicVenueScene />
          </div>
          <span className={own.optionTag}>Public</span>
          <span className={own.optionTitle}>Post it on chain</span>
          <span className={own.optionBody}>
            Anyone can read the amount, rate, term and collateral. You lock the wSOL now; the first lender to fund it pays you at
            once. Fastest way to borrow.
          </span>
          <span className={own.optionCta}>Continue in public →</span>
        </Link>
        <Link href="/devnet/private" className={own.option} data-private>
          <div className={own.optionArt}>
            <PrivateVenueScene />
          </div>
          <span className={own.optionTag} data-private>
            Private
          </span>
          <span className={own.optionTitle}>Negotiate in a sealed room</span>
          <span className={own.optionBody}>
            Open a private room, then publish a card showing only the fields you choose. Lenders ask to join; each sees only their
            own proposal. Nothing is locked until you accept.
          </span>
          <span className={own.optionCta}>Open a private room →</span>
        </Link>
      </div>
    </div>
  );
}

function PublicWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const requestedStep = Number(params.get("step") || 1);
  const step = Number.isInteger(requestedStep) && requestedStep >= 1 && requestedStep <= 4 ? requestedStep : 1;
  const heading = useRef<HTMLHeadingElement>(null);
  const [direction, setDirection] = useState(1);
  const { price } = usePrice();
  const { config } = useDevConfig();
  const { signer, publicKey, setConnectOpen, bumpRefresh } = useSigner();
  const balances = useBalances(publicKey, config);
  const toast = useToast();
  const { draft, update, reset, owed, principal, hydrated } = useDraft(price, DRAFT_KEY);
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState<"post" | "wrap" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<Posted | null>(null);
  const [touched, setTouched] = useState(false);

  const stepErrors: DraftErrors[] = [validateAmountStep(draft), validateTermsStep(draft), validateRiskStep(draft), {}];
  const valid = (n: number) => stepErrors.slice(0, n).every((e) => Object.keys(e).length === 0);
  const errors = touched ? stepErrors[step - 1] : {};

  const go = useCallback(
    (n: number) => {
      setDirection(n > step ? 1 : -1);
      setTouched(false);
      setError(null);
      router.replace(`${BASE}?venue=public${n === 1 ? "" : `&step=${n}`}`, { scroll: false });
    },
    [router, step]
  );

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

  const parsed = parseDraft(draft);
  const shortfall = parsed && balances ? parsed.collateralAmount - balances.wsol : null;
  const needsWrap = shortfall !== null && shortfall > 0n;

  const wrap = async () => {
    if (!signer || !shortfall) return;
    setError(null);
    setBusy("wrap");
    try {
      setSignature(await sendWrapSol(signer, shortfall));
      toast({ tone: "success", title: `Wrapped ${formatWsol(shortfall)} SOL` });
      bumpRefresh();
    } catch (e) {
      setError(e instanceof SubmissionError ? e.message : messageFromAnchorError(e));
      if (e instanceof SubmissionError && e.signature) setSignature(e.signature);
    } finally {
      setBusy(null);
    }
  };

  const post = async () => {
    setError(null);
    if (!signer || !publicKey) return setConnectOpen(true);
    if (!parsed || !config) {
      setError(config ? "Some terms are out of range. Go back and check them." : "Network configuration is unavailable. Retry the connection above.");
      return;
    }
    if (needsWrap) {
      setError(`You hold ${formatWsol(balances!.wsol)} wSOL. Wrap the difference first.`);
      return;
    }
    setBusy("post");
    try {
      const result = await new RequestService(signer, config).create(draft);
      setSignature(result.signature);
      setPosted({
        href: requestHref({ borrower: publicKey.toBase58(), requestId: BigInt(result.requestId) }),
        principal: parsed.principal,
        collateral: parsed.collateralAmount,
      });
      toast({ tone: "success", title: "Request is live", detail: `You locked ${formatWsol(parsed.collateralAmount)} wSOL.` });
      bumpRefresh();
      reset();
    } catch (e) {
      setError(e instanceof SubmissionError ? e.message : messageFromAnchorError(e));
      if (e instanceof SubmissionError && e.signature) setSignature(e.signature);
    } finally {
      setBusy(null);
    }
  };

  const current = STEPS[step - 1];

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.progress}>
          <LogoMark size={36} progress={posted ? 1 : (step - 1) / 4 + 0.08} />
          <div>
            <p className={styles.kicker}>{posted ? "Done" : `Public request · Step ${step} of 4 · ${current.title}`}</p>
            <ol className={styles.dots} aria-label="Steps">
              {STEPS.map((s, i) => {
                const n = i + 1;
                const reachable = n < step || valid(n - 1);
                return (
                  <li key={s.title}>
                    <button
                      type="button"
                      className={styles.dot}
                      data-state={posted || n < step ? "done" : n === step ? "current" : "todo"}
                      aria-current={n === step ? "step" : undefined}
                      aria-label={`${s.title}${n < step ? ", done" : ""}`}
                      disabled={Boolean(posted) || !reachable || n === step}
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
          {posted ? (
            <m.section
              key="done"
              className={styles.done}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className={styles.question}>Your request is live</h1>
              <p className={styles.moved}>
                You locked <span className="num">{formatWsol(posted.collateral)}</span> wSOL. Lenders on Discover can see it now;
                the first to fund it sends you <span className="num">{formatUsdc(posted.principal)}</span> USDC at once.
              </p>
              <div className={styles.doneActions}>
                <Link href={posted.href} className={styles.primaryLink}>
                  View request
                </Link>
                <Link href="/devnet/discover" className={own.textLink}>
                  Back to Discover
                </Link>
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
                if (e.key === "Enter" && step < 4 && (e.target as HTMLElement).tagName !== "BUTTON") {
                  e.preventDefault();
                  next();
                }
              }}
            >
              <h1 ref={heading} tabIndex={-1} className={styles.question}>
                {current.question}
              </h1>
              {step === 1 && (
                <StepAmount draft={draft} update={update} errors={errors} balance={null} onEnter={next} perspective="borrower" />
              )}
              {step === 2 && (
                <StepTerms draft={draft} update={update} errors={errors} principal={principal} owed={owed} perspective="borrower" />
              )}
              {step === 3 && <StepRisk draft={draft} update={update} errors={errors} price={price} owed={owed} perspective="borrower" />}
              {step === 4 && (
                <>
                  <StepReview draft={draft} owed={owed} price={price} onEdit={go} perspective="borrower" />
                  {signer && needsWrap && (
                    <div className={own.wrap}>
                      <p>
                        You hold <span className="num">{formatWsol(balances!.wsol)}</span> wSOL. This request locks{" "}
                        <span className="num">{formatWsol(parsed!.collateralAmount)}</span>. Wrap{" "}
                        <span className="num">{formatWsol(shortfall!)}</span> SOL into wSOL first; it stays yours.
                      </p>
                      <Button variant="secondary" loading={busy === "wrap"} disabled={busy === "post"} onClick={wrap}>
                        Wrap {formatWsol(shortfall!)} SOL
                      </Button>
                    </div>
                  )}
                </>
              )}

              <div className={styles.footer}>
                {step > 1 ? (
                  <Button variant="ghost" onClick={() => go(step - 1)}>
                    Back
                  </Button>
                ) : (
                  <Link href={BASE} className={own.textLink}>
                    Public or private
                  </Link>
                )}
                {step < 4 ? (
                  <Button size="lg" onClick={next}>
                    Continue
                  </Button>
                ) : (
                  <Button size="lg" loading={busy === "post"} disabled={busy === "wrap" || (Boolean(signer) && needsWrap)} onClick={post}>
                    {busy === "post" ? "Waiting for wallet and chain…" : signer ? "Lock wSOL and post request" : "Connect to post request"}
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
      <aside className={styles.aside} aria-label="Lender's view of this request">
        <OfferPreview draft={draft} owed={owed} price={price} live={Boolean(posted)} perspective="borrower" />
        {step > 0 && <Tip>{posted ? "Posted. Lenders can fund it from Discover." : TIPS[step - 1]}</Tip>}
      </aside>
    </div>
  );
}
