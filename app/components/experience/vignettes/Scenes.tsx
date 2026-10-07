import { Amount, Card, Check, Lock, Pill, Ring, Rows, Stage, vignette as s } from "./parts";

/* Every scene uses the landing page's example loan: 100 USDC for 7 days,
   5 USDC full-term interest, 1.1 wSOL collateral, SOL at $150. */

export function HeroScene() {
  return (
    <Stage label="An example ZenLo offer card: lend 100 USDC for 7 days, repay 105 USDC, secured by 1.1 wSOL, with the repayment clock and loan health shown beside it.">
      <Card style={{ marginRight: "18%", marginBlock: "16% 10%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Offer · 7 days</span>
          <Pill>Open</Pill>
        </div>
        <Amount value="100" unit="USDC" />
        <Rows
          items={[
            ["Full-term interest", "5 USDC"],
            ["Repay by the deadline", "105 USDC"],
            ["Collateral", "1.1 wSOL"],
          ]}
        />
        <span className={s.button}>Accept offer</span>
      </Card>
      <div className={`${s.chip} ${s.float}`} style={{ top: 0, right: "-2%" }}>
        <Ring left={0.86} />
        <div>
          <strong>6d 01h</strong>
          <span>Time to repay</span>
        </div>
      </div>
      <div className={`${s.chip} ${s.float}`} style={{ bottom: "1%", right: "4%" }}>
        <Pill tone="good">Healthy</Pill>
        <div>
          <strong>$165</strong>
          <span>Collateral value</span>
        </div>
      </div>
    </Stage>
  );
}

export function CtaScene() {
  return (
    <Stage label="An example repaid loan receipt: 105 USDC to the lender and 1.1 wSOL returned to the borrower.">
      <Card style={{ marginInline: "8%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Loan closed</span>
          <Pill tone="good">Repaid</Pill>
        </div>
        <Amount value="105" unit="USDC" />
        <Rows
          items={[
            ["Lender received", "100 + 5 USDC"],
            ["Borrower got back", "1.1 wSOL"],
            ["Closed on", "Day 6 of 7"],
          ]}
        />
      </Card>
    </Stage>
  );
}

/* Use-case scenes, keyed from use-cases.ts. */

function PrivateBorrow() {
  return (
    <Stage tone="navy" label="An example private room: the loan amount shows only to its members, while the public explorer shows it as hidden.">
      <Card tone="navy" style={{ marginRight: "30%", marginBottom: "22%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Private room · 2 members</span>
          <Lock />
        </div>
        <Amount value="100" unit="USDC" />
        <Rows items={[["Collateral", "1.1 wSOL"], ["Deadline", "7 days"]]} />
      </Card>
      <Card style={{ position: "absolute", bottom: 0, right: 0, width: "56%" }}>
        <span className={s.eyebrow}>Public explorer</span>
        <Rows
          items={[
            ["Amount", <span key="a" className={s.redact} />],
            ["Terms", <span key="t" className={s.redact} />],
          ]}
        />
      </Card>
    </Stage>
  );
}

function InvitedLend() {
  return (
    <Stage tone="navy" label="An example loan revision approved by both the lender and the borrower.">
      <Card style={{ marginInline: "6%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Revision 3 of 3</span>
          <Pill tone="good">Ready</Pill>
        </div>
        <Rows items={[["Amount", "100 USDC"], ["Interest", "5 USDC"], ["Term", "7 days"]]} />
        <Rows
          items={[
            [<span key="l" className={s.mono}>Lender 7xKX…9fQa</span>, <Check key="c1" />],
            [<span key="b" className={s.mono}>Borrower 4mNp…2wLe</span>, <Check key="c2" />],
          ]}
        />
      </Card>
    </Stage>
  );
}

function BlindBids() {
  const bids = [
    ["Offer A", "6 USDC", true],
    ["Offer B", "5 USDC", false],
    ["Offer C", "7 USDC", true],
  ] as const;
  return (
    <Stage tone="navy" label="An example request with three sealed offers; only the borrower sees all three and picks the cheapest.">
      <div className={s.lanes} style={{ gap: "0.6em" }}>
        {bids.map(([name, cost, dim]) => (
          <Card key={name} dim={dim} style={{ padding: "0.8em 1em" }}>
            <div className={s.head}>
              <span className={s.value}>{name}</span>
              <span className={s.label}>Interest {cost}</span>
              {dim ? <Lock /> : <Pill tone="good">Best</Pill>}
            </div>
          </Card>
        ))}
      </div>
    </Stage>
  );
}

function Liquidate() {
  return (
    <Stage tone="navy" label="An example liquidation quote: fund 105 USDC before it expires and receive wSOL including a 5% incentive.">
      <Card style={{ marginInline: "6%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Liquidation quote</span>
          <Pill tone="risk">Expires 0:42</Pill>
        </div>
        <Amount value="0.78" unit="wSOL" />
        <Rows items={[["You fund", "105 USDC"], ["Incentive", "+5%"]]} />
        <span className={s.button}>Fund quote</span>
      </Card>
    </Stage>
  );
}

function Learn() {
  return (
    <Stage label="An example of the demo: one loan played to repayment, with the other endings one tab away.">
      <Card style={{ marginInline: "4%" }}>
        <div className={s.tabs}>
          <span data-on>Repaid</span>
          <span>Liquidated</span>
          <span>Expired</span>
        </div>
        <div className={s.timeline}>
          <div>
            <b />
            <span>Offer</span>
          </div>
          <div>
            <b />
            <span>Borrow</span>
          </div>
          <div>
            <b />
            <span>Repay</span>
          </div>
        </div>
        <Rows items={[["Lender earns", "5 USDC"], ["Borrower gets back", "1.1 wSOL"]]} />
      </Card>
    </Stage>
  );
}

function Verify() {
  return (
    <Stage label="An example proof list: Devnet transaction signatures marked verified, and one item marked as public.">
      <Card style={{ marginInline: "4%" }}>
        <span className={s.eyebrow}>Proven on Devnet</span>
        <Rows
          items={[
            [<span key="1" className={s.mono}>5Yq2…hT8c · open room</span>, <Check key="a" />],
            [<span key="2" className={s.mono}>3kVd…P1zr · fund loan</span>, <Check key="b" />],
            [<span key="3" className={s.mono}>2bQe…Lm4w · settle</span>, <Check key="c" />],
            ["Deposit amounts", <Pill key="d">Public</Pill>],
          ]}
        />
      </Card>
    </Stage>
  );
}

function Desk() {
  return (
    <Stage tone="navy" label="An example private lender desk: its lending policy and two members, an admin and a lender.">
      <Card tone="navy" style={{ marginInline: "6%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Desk policy</span>
          <Lock />
        </div>
        <Rows items={[["Loan size", "100 to 500 USDC"], ["Starting LTV", "up to 60%"], ["Term", "7 to 30 days"]]} />
        <Rows
          items={[
            [<span key="o" className={s.mono}>7xKX…9fQa</span>, <Pill key="p1" tone="navy">Admin</Pill>],
            [<span key="m" className={s.mono}>9cTr…4hUe</span>, <Pill key="p2" tone="navy">Lender</Pill>],
          ]}
        />
      </Card>
    </Stage>
  );
}

function RepayEarly() {
  return (
    <Stage label="An example early payoff on day 3 of 7: interest is charged for the days used, never below the 25% minimum.">
      <Card style={{ marginInline: "6%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Repay early · day 3 of 7</span>
          <Pill tone="good">Days used</Pill>
        </div>
        <Amount value="102.14" unit="USDC" />
        <Rows
          items={[
            ["Interest for 3 days", "2.14 USDC"],
            ["Full-term interest", "5 USDC"],
          ]}
        />
        <span className={s.button}>Repay now</span>
      </Card>
    </Stage>
  );
}

function Auditor() {
  return (
    <Stage tone="navy" label="An example consent step: the borrower sees the named auditor before signing, and the auditor can read only after consent.">
      <Card style={{ marginInline: "6%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Who else can read this loan</span>
          <Lock />
        </div>
        <Rows
          items={[
            [<span key="a" className={s.mono}>Auditor 3fLm…8kPw</span>, <Pill key="n">Named</Pill>],
            ["Before you sign", <Pill key="h" tone="navy">Hidden</Pill>],
            ["After you sign", <Pill key="v" tone="good">Can read</Pill>],
          ]}
        />
        <span className={s.button}>Consent and sign</span>
      </Card>
    </Stage>
  );
}

function Alerts() {
  return (
    <Stage label="An example reminder: the loan is due in 24 hours and health has dropped to watch, with a link back to the loan.">
      <div className={s.lanes} style={{ gap: "0.6em", marginInline: "6%" }}>
        <Card style={{ padding: "0.8em 1em" }}>
          <div className={s.head}>
            <span className={s.value}>Due in 24 hours</span>
            <Ring left={0.14} size={32} />
          </div>
          <span className={s.label}>Repay 105 USDC to get 1.1 wSOL back.</span>
        </Card>
        <Card style={{ padding: "0.8em 1em" }}>
          <div className={s.head}>
            <span className={s.value}>Health: watch</span>
            <Pill tone="risk">LTV 78%</Pill>
          </div>
          <span className={s.label}>Top up or repay before 85%.</span>
        </Card>
      </div>
    </Stage>
  );
}

function CashOut() {
  return (
    <Stage label="An example cash-out handoff: 100 USDC leaves the wallet for a cash pickup, marked as not private.">
      <Card style={{ marginInline: "6%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Cash out</span>
          <Pill tone="risk">Not private</Pill>
        </div>
        <Amount value="100" unit="USDC" />
        <Rows items={[["Pick up", "Cash, local currency"], ["Your loan", "Not shared"]]} />
        <span className={s.button}>Continue to provider</span>
      </Card>
    </Stage>
  );
}

export const USE_CASE_SCENES = {
  "private-borrow": PrivateBorrow,
  "invited-lend": InvitedLend,
  "blind-bids": BlindBids,
  liquidate: Liquidate,
  learn: Learn,
  verify: Verify,
  desk: Desk,
  "repay-early": RepayEarly,
  auditor: Auditor,
  alerts: Alerts,
  "cash-out": CashOut,
} as const;

export type UseCaseScene = keyof typeof USE_CASE_SCENES;

export function UseCaseVisual({ scene }: { scene: UseCaseScene }) {
  const Scene = USE_CASE_SCENES[scene];
  return <Scene />;
}

/* Private chapter on the landing page. */

function PrivateRoom() {
  return (
    <Stage tone="navy" label="An example private room with two invited members; a shared link alone opens nothing.">
      <Card tone="navy" style={{ marginInline: "8%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Private room</span>
          <Lock />
        </div>
        <Rows
          items={[
            [<span key="b" className={s.mono}>4mNp…2wLe</span>, <Pill key="o" tone="navy">Owner</Pill>],
            [<span key="l" className={s.mono}>7xKX…9fQa</span>, <Pill key="i" tone="navy">Invited</Pill>],
            ["Anyone with the link", "No access"],
          ]}
        />
      </Card>
    </Stage>
  );
}

function PrivateSettle() {
  return (
    <Stage tone="navy" label="An example settled private loan: inside the room the terms are visible, while Solana shows only a balance change.">
      <Card tone="navy" style={{ marginRight: "30%", marginBottom: "34%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Inside the room</span>
          <Pill tone="good">Repaid</Pill>
        </div>
        <Rows items={[["Repaid", "105 USDC"], ["Returned", "1.1 wSOL"]]} />
      </Card>
      <Card style={{ position: "absolute", bottom: 0, right: 0, width: "56%" }}>
        <span className={s.eyebrow}>On Solana</span>
        <Rows
          items={[
            ["Balance change", "Public"],
            ["Terms", <span key="t" className={s.redact} />],
          ]}
        />
      </Card>
    </Stage>
  );
}

export const PRIVATE_SCENES = { room: PrivateRoom, agree: InvitedLend, settle: PrivateSettle } as const;

/* Request wizard: who can read the request. */

export function PublicVenueScene() {
  return (
    <Stage wide label="An example public request: amount, interest, term and collateral are readable by anyone.">
      <Card style={{ marginInline: "10%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Request · on chain</span>
          <Pill>Anyone can read</Pill>
        </div>
        <Rows
          items={[
            ["Borrow", "100 USDC"],
            ["Interest", "5 USDC"],
            ["Term", "7 days"],
            ["Collateral locked", "1.1 wSOL"],
          ]}
        />
      </Card>
    </Stage>
  );
}

export function PrivateVenueScene() {
  return (
    <Stage wide tone="navy" label="An example private request card: the borrower chooses which fields lenders can see; the rest stay hidden.">
      <Card tone="navy" style={{ marginInline: "10%" }}>
        <div className={s.head}>
          <span className={s.eyebrow}>Request card</span>
          <Lock />
        </div>
        <Rows
          items={[
            ["Borrow", "100 USDC"],
            ["Interest", <span key="i" className={s.redact} />],
            ["Term", "7 days"],
            ["Collateral", <span key="c" className={s.redact} />],
          ]}
        />
      </Card>
    </Stage>
  );
}
