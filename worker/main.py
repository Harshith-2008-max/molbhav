"""AI shopping worker: LangChain tools search + evaluate mock listings.
Runs without an API key (heuristic ranking); set ANTHROPIC_API_KEY to add an LLM-written verdict."""
import json, os, random, statistics, uuid
from fastapi import FastAPI
from pydantic import BaseModel, Field
from langchain_core.tools import tool
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

STORES = ["VoltMart", "ShopNest", "DealDock", "PrimeBazaar", "GadgetHub", "BudgetBarn"]
CONDITIONS = ["new", "new", "open-box", "refurbished"]

@tool
def search_deals(product: str, budget: float) -> str:
    """Search stores for listings of a product. Returns a JSON list (mock data, seeded by product name)."""
    rng = random.Random(product.lower().strip())
    base = max(budget * rng.uniform(0.8, 1.15), 5)
    out = []
    for store in STORES:
        for _ in range(rng.randint(1, 2)):
            cond = rng.choice(CONDITIONS)
            price = round(base * rng.uniform(0.55, 1.3) * (0.85 if cond != "new" else 1), 2)
            out.append({
                "id": uuid.uuid4().hex[:8], "store": store,
                "title": f"{product.title()} ({cond})", "condition": cond,
                "price": price, "shipping": rng.choice([0, 0, 4.99, 9.99]),
                "rating": round(rng.uniform(3.2, 5.0), 1),
                "seller_score": rng.randint(55, 100),
                "in_stock": rng.random() > 0.15,
            })
    return json.dumps(out)

@tool
def evaluate_listing(listing_json: str, budget: float, median_price: float) -> str:
    """Score one listing 0-100 and flag risks. Input is a listing JSON object."""
    l = json.loads(listing_json)
    total = l["price"] + l["shipping"]
    flags = []
    if not l["in_stock"]: flags.append("out of stock")
    if total > budget: flags.append("over budget")
    if l["price"] < 0.55 * median_price: flags.append("suspiciously cheap")
    if l["seller_score"] < 70: flags.append("low seller score")
    if l["condition"] != "new": flags.append(l["condition"])
    score = (
        max(0, (budget - total) / budget) * 40
        + l["rating"] / 5 * 30
        + l["seller_score"] / 100 * 20
        + (10 if l["condition"] == "new" else 4)
    )
    score -= 30 * sum(f in ("out of stock", "over budget", "suspiciously cheap") for f in flags)
    return json.dumps({**l, "total": round(total, 2), "score": round(max(score, 0), 1), "flags": flags})

@tool
def negotiate_price(listing_json: str, budget: float) -> str:
    """Haggle with a seller (mock). Sellers with higher seller_score concede more. Returns JSON {asked, got, price}."""
    l = json.loads(listing_json)
    rng = random.Random(l["id"])
    asked = 0.12 if l["price"] > 0.8 * budget else 0.08
    got = round(min(asked, ((l["seller_score"] - 50) / 50) * asked * rng.uniform(0.6, 1.2)), 3)
    got = max(got, 0)
    return json.dumps({"asked": asked, "got": got, "price": round(l["price"] * (1 - got), 2)})

verdict_chain = None
if os.getenv("ANTHROPIC_API_KEY"):
    from langchain_anthropic import ChatAnthropic
    llm = ChatAnthropic(model=os.getenv("MODEL", "claude-sonnet-5-5"), max_tokens=300)
    verdict_chain = ChatPromptTemplate.from_messages([
        ("system", "You are a careful shopping agent. In 2 sentences, justify the top pick and mention any risk. No hype."),
        ("human", "Product: {product}\nBudget: ${budget}\nTop 3 evaluated listings:\n{top}"),
    ]) | llm | StrOutputParser()

app = FastAPI()

class SearchReq(BaseModel):
    product: str = Field(min_length=2, max_length=80)
    budget: float = Field(gt=0, le=10000)

@app.post("/search")
def search(req: SearchReq):
    trace = [f"Heading to {len(STORES)} stores for \u201c{req.product}\u201d"]
    raw = json.loads(search_deals.invoke({"product": req.product, "budget": req.budget}))
    median = round(statistics.median(x["price"] for x in raw), 2)
    trace.append(f"Found {len(raw)} listings. Market median is ${median}")

    def score(x):
        return json.loads(evaluate_listing.invoke(
            {"listing_json": json.dumps(x), "budget": req.budget, "median_price": median}))

    scored = [score(x) for x in raw]
    for x in scored: x["market_median"] = median
    risky = sum(1 for x in scored if set(x["flags"]) & {"suspiciously cheap", "low seller score", "out of stock"})
    trace.append(f"Flagged {risky} risky or unavailable listings")

    buyable = sorted([x for x in scored if "over budget" not in x["flags"] and x["in_stock"]],
                     key=lambda x: x["score"], reverse=True)
    best = buyable[0] if buyable else None
    if best:
        h = json.loads(negotiate_price.invoke({"listing_json": json.dumps(best), "budget": req.budget}))
        if h["got"] > 0:
            new = score({**best, "price": h["price"]})
            new["market_median"], new["haggle"] = median, h
            scored = [new if x["id"] == best["id"] else x for x in scored]
            best = new
            trace.append(f"Haggled with {best['store']}: asked {h['asked']*100:.0f}% off, got {h['got']*100:.1f}%")
        else:
            trace.append(f"{best['store']} would not budge on price")
        trace.append(f"Picked {best['store']} at ${best['total']} total")
    else:
        trace.append("No in-stock listing fits the budget")
    scored.sort(key=lambda x: x["score"], reverse=True)

    summary = None
    if best and verdict_chain:
        try:
            summary = verdict_chain.invoke({"product": req.product, "budget": req.budget,
                                            "top": json.dumps(scored[:3], indent=1)})
        except Exception:
            summary = None
    if best and not summary:
        summary = f"{best['store']} has the best mix of price and trust: ${best['total']} total, rated {best['rating']}/5."
    return {"listings": scored, "best_id": best["id"] if best else None, "median": median,
            "trace": trace, "summary": summary or "Nothing fits your budget. Try raising it."}
