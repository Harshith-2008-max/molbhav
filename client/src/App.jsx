import { useEffect, useState } from "react";

const api = async (path, body) => {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j;
};
const usd = (n) => `$${n.toFixed(2)}`;

export default function App() {
  const [product, setProduct] = useState("");
  const [budget, setBudget] = useState("");
  const [run, setRun] = useState(null);
  const [shown, setShown] = useState(0);      // agent-log lines revealed so far
  const [pending, setPending] = useState(null);
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(null);

  useEffect(() => { // PayPal sends the buyer back with ?token=ORDER_ID
    const orderId = new URLSearchParams(location.search).get("token");
    if (!orderId) return;
    history.replaceState({}, "", location.pathname);
    setBusy(true);
    api("/api/checkout/capture", { orderId }).then(setReceipt).catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, []);

  useEffect(() => { // reveal the worker's trace line by line
    if (!run || shown >= run.trace.length) return;
    const t = setTimeout(() => setShown((s) => s + 1), 450);
    return () => clearTimeout(t);
  }, [run, shown]);

  const search = async (e) => {
    e.preventDefault(); setError(""); setRun(null); setShown(0); setBusy(true);
    try { setRun(await api("/api/search", { product, budget: Number(budget) })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const approve = async () => {
    setHolding(false); setBusy(true); setError("");
    try { const { approveUrl } = await api("/api/checkout/create", { runId: run.runId, listingId: pending.id }); location.href = approveUrl; }
    catch (err) { setError(err.message); setBusy(false); setPending(null); }
  };

  const holdKeys = {
    onKeyDown: (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); setHolding(true); } },
    onKeyUp: () => setHolding(false),
  };

  if (receipt) {
    const l = receipt.listing, saved = Math.max(0, l.market_median - l.price);
    return (
      <main className="wrap"><section className="ticket">
        <h1>Sold.</h1>
        <p>{l.title} from {l.store}</p>
        <p className="big">{usd(l.total)}</p>
        <p className="win">{saved > 0 ? `${usd(saved)} under the market median${l.haggle ? `, after a ${(l.haggle.got * 100).toFixed(1)}% haggle` : ""}.` : "Paid within your budget."}</p>
        <p className="muted">Sandbox payment, status {receipt.status}{receipt.captureId && `, capture ${receipt.captureId}`}</p>
        <button onClick={() => { setReceipt(null); setRun(null); }}>Haggle for something else</button>
      </section></main>
    );
  }

  const ready = run && shown >= run.trace.length;
  const best = run?.listings.find((l) => l.id === run.best_id);
  const cap = Number(budget);

  return (
    <main className="wrap">
      <header>
        <h1 className="mark">Molbhav</h1>
        <p className="tag-line">A haggling agent. It does the bargaining and never pays until you hold the button.</p>
      </header>

      <form className="ask" onSubmit={search}>
        <p>
          Find me{" "}
          <input aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="a pair of headphones" required minLength={2} size={Math.max(product.length, 18)} />
          {" "}for under ${" "}
          <input aria-label="Budget in USD" type="number" min="1" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="150" required className="amt" />
        </p>
        <button disabled={busy}>{busy && !run ? "Agent is out in the market…" : "Send the agent"}</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {run && (
        <ol className="log" aria-live="polite">
          {run.trace.slice(0, shown).map((t, i) => <li key={i}>{t}</li>)}
        </ol>
      )}

      {ready && (<>
        <section className="verdict"><p>{run.summary}</p></section>
        <ul className="shelf">
          {run.listings.map((l) => {
            const can = l.in_stock && l.total <= cap;
            return (
              <li key={l.id} className={`tag ${l.id === run.best_id ? "pick" : ""}`}>
                <div>
                  {l.id === run.best_id && <span className="badge">Agent’s pick</span>}
                  <strong>{l.store}</strong>
                  <span className="sub">{l.title}, {l.rating}★, seller {l.seller_score}/100</span>
                  {l.haggle && <span className="win">Haggled {(l.haggle.got * 100).toFixed(1)}% off</span>}
                  {l.flags.length > 0 && <span className="flags">{l.flags.join(", ")}</span>}
                </div>
                <div className="price">
                  <strong>{usd(l.total)}</strong>
                  <button className="small" disabled={!can} onClick={() => setPending(l)}>{can ? "Pick this" : "Unavailable"}</button>
                </div>
                <div className="meter" title="Share of your budget"><i className={l.total > cap ? "over" : ""} style={{ width: `${Math.min(l.total / cap, 1) * 100}%` }} /></div>
              </li>
            );
          })}
        </ul>
        {best && <p className="muted center">Bars show each total as a share of your {usd(cap)} budget.</p>}
      </>)}

      {pending && (
        <div className="scrim" role="dialog" aria-modal="true" aria-label="Approve purchase">
          <div className="sheet">
            <h2>{pending.title}</h2>
            <p className="muted">{pending.store}. {usd(pending.price)} item + {usd(pending.shipping)} shipping.</p>
            <p className="big">{usd(pending.total)}</p>
            <button className={`hold ${holding ? "holding" : ""}`} disabled={busy}
              onPointerDown={() => setHolding(true)} onPointerUp={() => setHolding(false)} onPointerLeave={() => setHolding(false)} onPointerCancel={() => setHolding(false)}
              onAnimationEnd={(e) => e.animationName === "fill" && approve()} {...holdKeys}>
              <span>{busy ? "Opening PayPal…" : "Hold to approve and pay"}</span>
            </button>
            <p className="muted">Hold for one second. You then confirm in PayPal (sandbox).</p>
            <button className="small ghost" onClick={() => setPending(null)} disabled={busy}>Not this one</button>
          </div>
        </div>
      )}
    </main>
  );
}
