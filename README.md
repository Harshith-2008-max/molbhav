# AI Shopping Agent

React dashboard → Node/Express API → Python worker (FastAPI + LangChain). PayPal Checkout runs in **sandbox** only.

Flow: enter product + budget → worker's `search_deals` and `evaluate_listing` tools rank mock listings → you review the pick → **Approve & pay** creates a PayPal order → you approve in PayPal → server captures.

## Run (three terminals)
```bash
# 1. Worker
cd worker && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...   # optional: adds an LLM-written verdict
uvicorn main:app --port 8000

# 2. API
cd server && cp .env.example .env   # add sandbox PAYPAL_CLIENT_ID / PAYPAL_SECRET
npm install && npm start

# 3. UI
cd client && npm install && npm run dev   # http://localhost:5173
```
Sandbox credentials: developer.paypal.com → Apps & Credentials → Sandbox. Pay with a sandbox personal test account.

## Safety design
- No payment call happens until the user taps Approve & pay.
- Price and budget are checked server-side against stored listings; the client sends only IDs.
- Mock data only. Swap `search_deals` for a real retailer API to go beyond a demo.
- State is in memory; use a database before deploying.

## What makes Molbhav different
- **Haggling agent:** a third LangChain tool, `negotiate_price`, bargains with the seller of the top pick and the saving flows into the price and score.
- **Visible agent log:** the worker returns its steps (search, flag, haggle, pick) and the UI replays them line by line.
- **Hold-to-approve:** one deliberate one-second gesture is the human approval gate before PayPal is called.
- **Sentence form and price-tag shelf:** the input reads like a sentence, and results are price tags with budget bars.
