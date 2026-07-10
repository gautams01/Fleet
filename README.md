# Inference Cost Modeler

https://fleet-umber.vercel.app/

An interactive model of LLM inference economics from both sides of the market, in a single React dashboard with two tabs:

- **Buyer-side** — you run inference workloads. Size the GPU fleet a workload needs, compare self-hosting against API pricing, and work through the commitment economics (on-demand vs. reserved vs. spot vs. owned hardware).
- **Seller-side** — you hold GPU supply. Turn a fleet's cost basis into sellable capacity and margin, weigh renting raw GPU-hours against serving open-model tokens, and find where to price as market rates fall.

Both dashboards share the same physics engine, so a fleet configured on the buyer side produces numbers consistent with the same hardware viewed from the seller side.

## Buyer-side: fleet sizing & self-host vs. API

Given a model, workload profile (input/output token lengths, request rate, burst multiplier, latency SLA), and hardware choice, the tool computes:

- **Fleet size and cost** — replicas needed, total GPUs, monthly cost, blended $/1M tokens
- **Hardware comparison** — the same workload evaluated across every GPU/cloud-instance option, ranked by monthly cost
- **Self-host vs. API break-even** — at what volume self-hosting beats serverless API pricing for the same model
- **Commitment & ownership economics** — all-on-demand vs. all-reserved vs. a blended base+burst portfolio vs. owning hardware in colo, with break-even fleet-retention for reservations and payback months for ownership
- **Sensitivity sweeps** — cost vs. request rate, context length, output length, or latency SLA
- **Roofline diagnostics** — whether the chosen configuration is memory- or compute-bound, and why

## Seller-side: compute provider / aggregator P&L

Given a fleet at some cost basis (owned + colo, or wholesale lease) and a monetization mix, the tool computes:

- **Monthly P&L** — revenue (tokens + rental), COGS (fleet + spot burst + egress), gross margin, and contribution margin after S&M
- **Model league table** — revenue per GPU-hour for every serveable open model at market token prices vs. renting the GPU raw; the aggregator's core capital-allocation question
- **Price optimization** — margin vs. discount under a demand-elasticity assumption, with overflow demand above 100% fill optionally served on spot supply
- **Hardware generation comparison** — the same monthly budget spent on H100 vs. H200 vs. B200 vs. A100 vs. L40S, and what each fleet earns for the same product mix
- **Utilization sensitivity** — margin at each sold-utilization level, with break-even; fixed fleet COGS against variable demand is the crux of the business
- **Multi-year projection** — market token prices decline (default 40%/yr) and rental rates decline (default 25%/yr) against a fixed cost basis. Owned hardware gets a "second act" after depreciation completes (cost collapses to power + colo); leased supply does not, which is why term length is the margin decision
- **Portfolio serving** — split the token fleet across two models, guided by the league table

## The physics engine

Fleet capacity comes from a roofline model of transformer inference, not rules of thumb:

- **KV-cache-aware decode**: bytes per decode step = weight reads + batch × KV(average context). At long context, KV reads rival or exceed weight reads — ignoring them materially overstates throughput for agent-style workloads.
- **KV sizing on input + output tokens** (footprint peaks at end of generation), with KV cache dtype (FP16/FP8) as an explicit choice independent of weight quantization.
- **Practical tensor parallelism**: TP widths restricted to 1/2/4/8 (then cross-node), with ~7% all-reduce overhead per doubling within NVLink and a steep cross-node penalty. TP width is *searched* for the cheapest fleet rather than fixed at the minimum that fits weights.
- **SLA-constrained batching**: auto-batch picks the largest batch that still meets the latency budget. When even batch=1 misses the SLA, the tool says so — adding replicas reduces queueing, not service time.
- **MoE batched decode** reads min(total, active × batch) expert weights — distinct tokens route to distinct experts, so batched MoE approaches reading all expert weights. DeepSeek's MLA KV compression is modeled via a per-token override.
- **Efficiency factors**: 60% of peak dense compute, 85% of peak memory bandwidth, plus (seller-side) a user-set serving-efficiency haircut for multi-tenancy and scheduling gaps. Outputs are roofline upper bounds; production engines typically achieve 50–80% of them.

## Assumptions & caveats

- **All prices are static snapshots (April 2026)** — cloud instance rates, GPU purchase prices, market rental rates, and open-model API prices. They are the single biggest sensitivity in the model; refresh before using for real decisions.
- Demand elasticity is linear; real demand curves bend.
- Prefix-cache hits skip prefill compute and bill at 10% of input price; KV memory for shared prefixes is conservatively not deduplicated.
- Egress is computed (~4 bytes per output token) largely to show it's negligible for token serving.
- Not modeled: per-model demand curves (portfolio allocation is manual), financing costs / cost of capital, multi-region supply, and residual value beyond a straight-line reduction of the depreciable base.

Every assumption that matters is exposed as a labeled control with a stated default rather than buried in the code.

## Repo contents

| File | Description |
|---|---|
| `src/App.jsx` | Combined dashboard — buyer-side and seller-side behind a top tab bar. Each side is fully self-contained in its own scope; both stay mounted so control state persists when switching tabs. |
| `index.html`, `src/main.jsx`, `vite.config.js`, `package.json` | Minimal Vite scaffold that mounts the dashboard |

## Disclaimer

This is an estimation and reasoning tool, not a procurement system. Throughput figures are analytical upper bounds, prices are dated snapshots, and several market parameters (elasticity, price-decline rates, serving efficiency) are assumptions you should pressure-test against your own data before committing capital.
