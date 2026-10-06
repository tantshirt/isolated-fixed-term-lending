import Image from "next/image";
import s from "./Landing.module.css";

const ROWS = [
  {
    other: "Terms change after you sign.",
    sharky: "Amount, full-term cost, collateral, and deadline are fixed before anyone commits.",
  },
  {
    other: "The real cost hides in the fine print.",
    sharky: "One cost for the whole term. 100 USDC at 5% costs 5 USDC, even if you repay early.",
  },
  {
    other: "Your collateral disappears into their books.",
    sharky: "Collateral sits in a program vault for this one loan, readable on Solana.",
  },
  {
    other: "Someone decides when you are late.",
    sharky: "The program enforces the deadline. Nobody can move it, including us.",
  },
];

/** "Bad sharks vs Sharky": the joke in the name, then the mechanics that answer it. */
export function SharkContrast() {
  return (
    <section className={s.contrast} aria-labelledby="contrast-h">
      <div className={s.contrastHead}>
        <p className={s.eyebrow}>About the name</p>
        <h2 id="contrast-h">
          You have met loan sharks.
          <br />
          Sharky shows his paperwork.
        </h2>
        <p className={s.lede}>
          A loan shark hides the terms. LegitShark puts them on the table, and
          on chain, before either side signs.
        </p>
      </div>
      <div className={s.contrastArt}>
        <Image
          src="/illustrations/sharky-bad-sharks.webp"
          width={1600}
          height={1060}
          sizes="(max-width: 800px) 92vw, 1100px"
          alt="Sharky holds his term sheet wide open while two grey, shadowy sharks behind him hide rolled-up papers behind their backs."
        />
      </div>
      <table className={s.contrastTable}>
        <thead>
          <tr>
            <th scope="col">Other sharks</th>
            <th scope="col">Sharky</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.other}>
              <td>
                <span className={s.contrastMark} aria-hidden>
                  ✕
                </span>
                <span className="visually-hidden">Other sharks: </span>
                {r.other}
              </td>
              <td>
                <span className={s.contrastCheck} aria-hidden>
                  ✓
                </span>
                <span className="visually-hidden">Sharky: </span>
                {r.sharky}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
