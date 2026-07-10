import { useState, useMemo, useCallback } from "react";

// ═════════════════════════════════════════════════════════════════════════════
// INFERENCE COST MODELER v3
// Two complete, independent dashboards in one place:
//   BUYER-SIDE  — GPU Fleet Sizer v2: "what fleet do I need, and should I
//                 self-host or use APIs?" (KV-aware roofline, TP search,
//                 commitment & ownership economics)
//   SELLER-SIDE — Compute provider / aggregator P&L: "I hold GPU supply at a
//                 cost basis — what's my margin selling GPU-hours vs tokens?"
// Each dashboard is wrapped in its own scope, byte-identical to its standalone
// version — nothing consolidated, nothing changed. Both stay mounted so slider
// state persists when switching tabs.
// ═════════════════════════════════════════════════════════════════════════════

const BuyerSideApp = (() => {

// ─── Constants ──────────────────────────────────────────────────────────────

const GPU_SPECS = {
  H100: { vram: 80, fp16_tflops: 989, int8_tops: 1979, mem_bw: 3350, tdp: 700 },
  H200: { vram: 141, fp16_tflops: 989, int8_tops: 1979, mem_bw: 4800, tdp: 700 },
  B200: { vram: 192, fp16_tflops: 2250, int8_tops: 4500, mem_bw: 8000, tdp: 1000 },
  A100_80: { vram: 80, fp16_tflops: 312, int8_tops: 624, mem_bw: 2039, tdp: 300 },
  A100_40: { vram: 40, fp16_tflops: 312, int8_tops: 624, mem_bw: 1555, tdp: 250 },
  // NOTE (v2 fix): L40S/L4 previously used with-sparsity tensor specs while other GPUs used
  // dense specs. LLM inference doesn't use 2:4 structured sparsity, so dense is correct.
  L40S: { vram: 48, fp16_tflops: 181, int8_tops: 362, mem_bw: 864, tdp: 350 },
  L4: { vram: 24, fp16_tflops: 61, int8_tops: 121, mem_bw: 300, tdp: 72 },
};

// Provider-level profiles: egress pricing, virtualization overhead, included extras
// Sourced from public pricing pages and GMI Cloud's TCO comparison
const PROVIDER_PROFILES = {
  "AWS":       { egressPerGb: 0.090, virtualizationOverhead: 0.10, crossAzPerGb: 0.020, storageIncluded: false, notes: "Hypervisor + EBS storage charged separately" },
  "Azure":     { egressPerGb: 0.087, virtualizationOverhead: 0.12, crossAzPerGb: 0.020, storageIncluded: false, notes: "Hyper-V virtualization, Managed Disks separate" },
  "GCP":       { egressPerGb: 0.085, virtualizationOverhead: 0.08, crossAzPerGb: 0.010, storageIncluded: false, notes: "KVM virtualization, Persistent Disk separate" },
  "Lambda":    { egressPerGb: 0.005, virtualizationOverhead: 0.02, crossAzPerGb: 0,     storageIncluded: true,  notes: "Bare-metal, NVMe included, minimal egress fees" },
  "RunPod":    { egressPerGb: 0.000, virtualizationOverhead: 0.03, crossAzPerGb: 0,     storageIncluded: true,  notes: "Free egress, container-based, NVMe included" },
  "Vast.ai":   { egressPerGb: 0.000, virtualizationOverhead: 0.05, crossAzPerGb: 0,     storageIncluded: true,  notes: "Marketplace, free egress, varies by host" },
  "CoreWeave": { egressPerGb: 0.020, virtualizationOverhead: 0.04, crossAzPerGb: 0.005, storageIncluded: true,  notes: "K8s native, low egress, NVMe included" },
};

// Cloud instance catalog — prices per INSTANCE/hour (on-demand, US region)
// Sources: cloudprice.net (Azure VMs, AWS EC2, GCP Compute), Apr 2026
const CLOUD_INSTANCES = [
  // ── Azure (cloudprice.net) ──
  { id: "az_nc40_h100",   provider: "Azure",  instance: "NC40ads_H100_v5",       gpu: "H100",   gpus: 1, ondemand: 6.98,  spot: 2.09,  reserved1y: 4.47, region: "East US",       link: "https://cloudprice.net/vm/Standard_NC40ads_H100_v5" },
  { id: "az_nc80_h100",   provider: "Azure",  instance: "NC80adis_H100_v5",      gpu: "H100",   gpus: 2, ondemand: 13.96, spot: 4.19,  reserved1y: 8.94, region: "East US",       link: "https://cloudprice.net/vm/Standard_NC80adis_H100_v5" },
  { id: "az_nd96_h100",   provider: "Azure",  instance: "ND96isr_H100_v5",       gpu: "H100",   gpus: 8, ondemand: 98.32, spot: 29.50, reserved1y: 62.92, region: "East US",     link: "https://cloudprice.net/vm/Standard_ND96isr_H100_v5" },
  { id: "az_nc24_a100",   provider: "Azure",  instance: "NC24ads_A100_v4",       gpu: "A100_80",gpus: 1, ondemand: 3.67,  spot: 1.10,  reserved1y: 2.24, region: "East US",       link: "https://cloudprice.net/vm/Standard_NC24ads_A100_v4" },
  { id: "az_nc48_a100",   provider: "Azure",  instance: "NC48ads_A100_v4",       gpu: "A100_80",gpus: 2, ondemand: 7.35,  spot: 2.20,  reserved1y: 4.48, region: "East US",       link: "https://cloudprice.net/vm/Standard_NC48ads_A100_v4" },
  { id: "az_nc96_a100",   provider: "Azure",  instance: "NC96ads_A100_v4",       gpu: "A100_80",gpus: 4, ondemand: 14.69, spot: 4.41,  reserved1y: 8.97, region: "East US",       link: "https://cloudprice.net/vm/Standard_NC96ads_A100_v4" },
  { id: "az_nd96_a100",   provider: "Azure",  instance: "ND96amsr_A100_v4",      gpu: "A100_80",gpus: 8, ondemand: 32.77, spot: 9.83,  reserved1y: 20.05, region: "East US",     link: "https://cloudprice.net/vm/Standard_ND96amsr_A100_v4" },
  // ── AWS EC2 (cloudprice.net/aws/ec2) ──
  { id: "aws_p5_48xl",    provider: "AWS",    instance: "p5.48xlarge",            gpu: "H100",   gpus: 8, ondemand: 55.04, spot: 20.00, reserved1y: 33.92, region: "us-east-1",    link: "https://cloudprice.net/aws/ec2/instances/p5.48xlarge" },
  { id: "aws_p5e_48xl",   provider: "AWS",    instance: "p5e.48xlarge (H200)",    gpu: "H200",   gpus: 8, ondemand: 75.00, spot: 27.00, reserved1y: 48.75, region: "us-east-1",    link: "https://cloudprice.net/aws/ec2" },
  { id: "aws_p6_b200",    provider: "AWS",    instance: "p6-b200.48xlarge",       gpu: "B200",   gpus: 8, ondemand: 107.52,spot: 40.00, reserved1y: 72.00, region: "us-east-1",    link: "https://cloudprice.net/aws/ec2" },
  { id: "aws_p4d_24xl",   provider: "AWS",    instance: "p4d.24xlarge",           gpu: "A100_40",gpus: 8, ondemand: 32.77, spot: 12.44, reserved1y: 19.22, region: "us-east-1",    link: "https://cloudprice.net/aws/ec2/instances/p4d.24xlarge" },
  { id: "aws_p4de_24xl",  provider: "AWS",    instance: "p4de.24xlarge",          gpu: "A100_80",gpus: 8, ondemand: 40.97, spot: 15.57, reserved1y: 26.23, region: "us-east-1",    link: "https://cloudprice.net/aws/ec2/instances/p4de.24xlarge" },
  { id: "aws_g6e_48xl",   provider: "AWS",    instance: "g6e.48xlarge (L40S)",    gpu: "L40S",   gpus: 8, ondemand: 13.74, spot: 5.15,  reserved1y: 8.93, region: "us-east-1",     link: "https://cloudprice.net/aws/ec2" },
  { id: "aws_g6_xlarge",  provider: "AWS",    instance: "g6.xlarge (L4)",         gpu: "L4",     gpus: 1, ondemand: 0.805, spot: 0.24,  reserved1y: 0.51, region: "us-east-1",     link: "https://cloudprice.net/aws/ec2" },
  // ── GCP (cloudprice.net/gcp/compute) ──
  { id: "gcp_a3_mega",    provider: "GCP",    instance: "a3-megagpu-8g",          gpu: "H100",   gpus: 8, ondemand: 88.49, spot: 26.55, reserved1y: 55.75, region: "us-central1",  link: "https://cloudprice.net/gcp/compute" },
  { id: "gcp_a3_high_8g", provider: "GCP",    instance: "a3-highgpu-8g (H200)",   gpu: "H200",   gpus: 8, ondemand: 100.00,spot: 30.00, reserved1y: 65.00, region: "us-central1",  link: "https://cloudprice.net/gcp/compute" },
  { id: "gcp_a2_mega_16", provider: "GCP",    instance: "a2-megagpu-16g",         gpu: "A100_40",gpus: 16,ondemand: 55.74, spot: 16.72, reserved1y: 35.12, region: "us-central1",  link: "https://cloudprice.net/gcp/compute" },
  { id: "gcp_a2_high_1g", provider: "GCP",    instance: "a2-highgpu-1g",          gpu: "A100_40",gpus: 1, ondemand: 3.67,  spot: 1.10,  reserved1y: 2.31, region: "us-central1",   link: "https://cloudprice.net/gcp/compute" },
  { id: "gcp_a2_ultra_1g",provider: "GCP",    instance: "a2-ultragpu-1g",         gpu: "A100_80",gpus: 1, ondemand: 5.00,  spot: 1.50,  reserved1y: 3.15, region: "us-central1",   link: "https://cloudprice.net/gcp/compute" },
  { id: "gcp_g2_std_4",   provider: "GCP",    instance: "g2-standard-4 (L4)",     gpu: "L4",     gpus: 1, ondemand: 0.84,  spot: 0.25,  reserved1y: 0.53, region: "us-central1",   link: "https://cloudprice.net/gcp/compute" },
  // ── Specialist providers (from search data) ──
  { id: "lambda_h100",    provider: "Lambda", instance: "1×H100 SXM",             gpu: "H100",   gpus: 1, ondemand: 2.99,  spot: null,  reserved1y: null, region: "US",            link: "https://lambda.ai/pricing" },
  { id: "lambda_8h100",   provider: "Lambda", instance: "8×H100 SXM node",        gpu: "H100",   gpus: 8, ondemand: 23.92, spot: null,  reserved1y: null, region: "US",            link: "https://lambda.ai/pricing" },
  { id: "lambda_b200",    provider: "Lambda", instance: "1×B200",                  gpu: "B200",   gpus: 1, ondemand: 5.50,  spot: null,  reserved1y: null, region: "US",            link: "https://lambda.ai/pricing" },
  { id: "runpod_h100",    provider: "RunPod", instance: "1×H100 SXM (community)", gpu: "H100",   gpus: 1, ondemand: 2.69,  spot: 1.99,  reserved1y: null, region: "US/EU",         link: "https://www.runpod.io/pricing" },
  { id: "runpod_a100",    provider: "RunPod", instance: "1×A100 80GB",             gpu: "A100_80",gpus: 1, ondemand: 1.64,  spot: 1.19,  reserved1y: null, region: "US/EU",         link: "https://www.runpod.io/pricing" },
  { id: "vast_h100",      provider: "Vast.ai",instance: "1×H100 (marketplace)",    gpu: "H100",   gpus: 1, ondemand: 1.87,  spot: 1.49,  reserved1y: null, region: "varies",        link: "https://cloud.vast.ai/" },
  { id: "coreweave_h100", provider: "CoreWeave",instance: "1×H100 SXM",           gpu: "H100",   gpus: 1, ondemand: 6.16,  spot: null,  reserved1y: 2.21, region: "US",            link: "https://coreweave.com/pricing" },
];

// Legacy compat: build GPU_CATALOG from specs for the compute engine
const GPU_CATALOG = {};
for (const [k, v] of Object.entries(GPU_SPECS)) {
  // Find cheapest on-demand per-GPU price across all instances for this GPU
  const instances = CLOUD_INSTANCES.filter(ci => ci.gpu === k);
  const cheapest = instances.length > 0 ? Math.min(...instances.map(ci => ci.ondemand / ci.gpus)) : 3.50;
  GPU_CATALOG[k] = { ...v, name: k.replace("_", " "), hourly: cheapest };
}

const MODEL_PRESETS = {
  "1B": { name: "~1B", params_b: 1.24, layers: 16, hidden: 2048, heads: 32, kv_heads: 8 },
  "3B": { name: "~3B", params_b: 3.21, layers: 28, hidden: 3072, heads: 24, kv_heads: 8 },
  "7B": { name: "~7B", params_b: 6.7, layers: 32, hidden: 4096, heads: 32, kv_heads: 32 },
  "8B": { name: "~8B (Llama 3)", params_b: 8.03, layers: 32, hidden: 4096, heads: 32, kv_heads: 8 },
  "13B": { name: "~13B", params_b: 13, layers: 40, hidden: 5120, heads: 40, kv_heads: 40 },
  "22B": { name: "~22B (Mistral Small)", params_b: 22, layers: 56, hidden: 6144, heads: 48, kv_heads: 8 },
  "70B": { name: "~70B (Llama 3)", params_b: 70.6, layers: 80, hidden: 8192, heads: 64, kv_heads: 8 },
  "123B": { name: "~123B (Mistral Large)", params_b: 123, layers: 88, hidden: 12288, heads: 96, kv_heads: 8 },
  "405B": { name: "~405B (Llama 3)", params_b: 405, layers: 126, hidden: 16384, heads: 128, kv_heads: 8 },
  // v2 fix: DeepSeek uses Multi-head Latent Attention (MLA) — compressed KV latent is ~70KB/token
  // at FP16, not the ~1.75MB/token that naive MHA math (kv_heads=128) implies. kv_bytes_override
  // is bytes/token at 2-byte elements; halved automatically if KV cache dtype is FP8.
  "671B_MoE": { name: "~671B MoE (DeepSeek)", params_b: 671, layers: 61, hidden: 7168, heads: 128, kv_heads: 128, moe: true, active_params_b: 37, kv_bytes_override: 70_000 },
};

const QUANT_LEVELS = {
  FP16: { bits: 16, label: "FP16/BF16" },
  FP8: { bits: 8, label: "FP8" },
  INT8: { bits: 8, label: "INT8 (W8A8)" },
  INT4: { bits: 4, label: "INT4 (GPTQ/AWQ)" },
  "Q4_K_M": { bits: 4.5, label: "GGUF Q4_K_M" },
};

// Each API has an open-source equivalent for fair self-host comparison.
// "selfHostModel" is the model key in MODEL_PRESETS to use when computing what self-hosting would cost
// to match this API's capability tier. "tier" indicates capability class: budget/mid/frontier.
const API_BENCHMARKS = [
  { name: "Claude Opus 4.6",     input: 5.00, output: 25.00, selfHostModel: "405B",    tier: "frontier", note: "Compare to self-hosted Llama 3 405B (frontier-tier open model)" },
  { name: "Claude Sonnet 4.6",   input: 3.00, output: 15.00, selfHostModel: "70B",     tier: "mid",      note: "Compare to self-hosted Llama 3 70B" },
  { name: "GPT-5.2",             input: 1.75, output: 14.00, selfHostModel: "70B",     tier: "mid",      note: "Compare to self-hosted Llama 3 70B" },
  { name: "GPT-5 Mini",          input: 0.25, output: 2.00,  selfHostModel: "32B",     tier: "mid",      note: "Compare to self-hosted Qwen 2.5 32B" },
  { name: "DeepSeek V3.2",       input: 0.14, output: 0.28,  selfHostModel: "671B_MoE",tier: "frontier", note: "Compare to self-hosted DeepSeek V3 (671B MoE)" },
  { name: "Gemini 2.5 Flash",    input: 0.30, output: 2.50,  selfHostModel: "32B",     tier: "mid",      note: "Compare to self-hosted Qwen 2.5 32B (similar capability)" },
  { name: "Claude Haiku 4.5",    input: 1.00, output: 5.00,  selfHostModel: "32B",     tier: "mid",      note: "Compare to self-hosted Qwen 2.5 32B" },
  { name: "Llama 4 Maverick",    input: 0.15, output: 0.60,  selfHostModel: "123B",    tier: "mid",      note: "Compare to self-hosted Mistral Large 123B" },
  { name: "Mistral Small",       input: 0.20, output: 0.60,  selfHostModel: "8B",      tier: "budget",   note: "Compare to self-hosted Llama 3 8B (similar size)" },
];

// ─── Core Engine ────────────────────────────────────────────────────────────

function computeFleet(cfg) {
  const gpu = cfg._gpuOverride || GPU_CATALOG[cfg.gpu];
  const quant = QUANT_LEVELS[cfg.quant];
  const m = MODEL_PRESETS[cfg.model];
  const effective_params = m.moe ? m.active_params_b : m.params_b;
  const bytes_per_param = quant.bits / 8;

  // ── Memory math ──
  const weight_gb = m.params_b * bytes_per_param; // params (B) × bytes/param = GB
  const head_dim = m.hidden / m.heads;
  // v2 fix: KV cache dtype is an explicit, independent choice (FP16 default, FP8 halves it).
  // v1 tied KV dtype to weight quantization backwards (INT4 weights → 1-byte KV, which is
  // not how serving engines work — AWQ/GPTQ weights typically run FP16 KV).
  const kv_elem_bytes = cfg.kvCacheDtype === "FP8" ? 1 : 2;
  const kv_bytes_per_token = m.kv_bytes_override
    ? m.kv_bytes_override * (kv_elem_bytes / 2)
    : 2 * m.kv_heads * head_dim * kv_elem_bytes * m.layers;
  // v2 fix: KV footprint peaks at END of generation = input + output tokens.
  // v1 sized KV on input tokens only, understating memory by output/input ratio.
  const max_ctx_tokens = cfg.avgSeqLen + cfg.avgOutputTokens;
  const kv_per_req_gb = kv_bytes_per_token * max_ctx_tokens / 1e9;
  // Average KV length read per decode step ≈ input + half the output (grows during decode)
  const avg_decode_ctx = cfg.avgSeqLen + cfg.avgOutputTokens / 2;
  const kv_read_gb_per_stream_step = kv_bytes_per_token * avg_decode_ctx / 1e9;

  // v2 fix: tensor-parallel width must be a practical size (1/2/4/8/16/32); TP=3 or TP=5
  // doesn't divide attention heads and isn't deployed in practice.
  const PRACTICAL_TP = [1, 2, 4, 8, 16, 32, 64];
  const raw_min = Math.ceil((weight_gb + 2) / (gpu.vram * 0.92));
  const min_gpus_weights = raw_min;
  const latencyBudgetS = (cfg.latencyTargetMs || 99999) / 1000;
  const avg_output_tokens = cfg.avgOutputTokens;
  const avg_input_tokens = cfg.avgSeqLen;
  const peakMult = cfg.peakMultiplier || 1;
  const provisionRPS = cfg.targetRPS * peakMult;

  // ── Evaluate one candidate TP width; returns full sizing or null if infeasible ──
  const evalTP = (tp) => {
    const replica_vram = gpu.vram * tp * 0.92;
    const vram_for_kv = replica_vram - weight_gb - 2;
    if (vram_for_kv < kv_per_req_gb) return null; // can't hold even one request's KV

    // v2 fix: tensor parallelism isn't free. All-reduce after every layer costs ~7% per
    // doubling within an NVLink domain (TP≤8). Beyond 8 GPUs, TP spans nodes over
    // InfiniBand — a steep penalty (~45% per doubling). This stops the TP search from
    // unrealistically concluding that a 32-wide TP group is optimal for a 70B model.
    const tpEff = tp <= 8
      ? Math.pow(0.93, Math.log2(tp))
      : Math.pow(0.93, 3) * Math.pow(0.55, Math.log2(tp / 8));
    const max_concurrent_per_replica = Math.max(Math.floor(vram_for_kv / kv_per_req_gb), 1);

    const effective_bw = gpu.mem_bw * tp * 0.85 * tpEff; // GB/s aggregate, 85% achievable × TP efficiency
    const compute_tflops = (quant.bits <= 8 ? gpu.int8_tops : gpu.fp16_tflops) * tp * 0.6 * tpEff;

    // v2 fix: decode step time includes KV-cache reads, which v1 ignored entirely.
    // At long context these rival or exceed weight reads (e.g. 70B @ 8K ctx, batch 32:
    // ~86GB KV vs 70GB weights per step). v1 materially overstated long-context throughput.
    // MoE: weights read per step ≈ min(total, active × batch) — distinct tokens route to
    // distinct experts, so batched MoE decode approaches reading ALL expert weights.
    // v1 scaled active-params linearly with batch, overstating MoE batch throughput.
    const weightReadGb = (B) => m.moe
      ? Math.min(m.params_b, m.active_params_b * B) * bytes_per_param
      : weight_gb;
    const stepTime = (B) => {
      const t_mem = (weightReadGb(B) + B * kv_read_gb_per_stream_step) / effective_bw;
      const t_comp = (B * 2 * effective_params * 1e9) / (compute_tflops * 1e12);
      return Math.max(t_mem, t_comp);
    };
    const prefill_tps = (compute_tflops * 1e12) / (2 * effective_params * 1e9);
    const reqTime = (B) => avg_input_tokens / prefill_tps + avg_output_tokens * stepTime(B);

    // ── Batch selection ──
    // v2 fix: v1 "fixed" SLA misses by multiplying replicas (queuePenalty) — but adding
    // replicas cannot reduce service time, only queueing. The correct lever is batch size:
    // per-stream decode rate = 1/stepTime(B), which SLOWS as batch grows (more KV + expert
    // bytes per step). So auto mode picks the LARGEST batch that still meets the SLA —
    // max throughput subject to the latency constraint. Burst headroom (peakMultiplier)
    // is the knob that keeps queueing delay low.
    const candidates = [];
    for (let B = 1; B <= Math.min(max_concurrent_per_replica, 512); B = B < 8 ? B + 1 : B * 2) candidates.push(B);
    if (!candidates.includes(max_concurrent_per_replica) && max_concurrent_per_replica <= 512) candidates.push(max_concurrent_per_replica);

    let actual_concurrent;
    if (cfg.concurrentPerReplica && cfg.concurrentPerReplica > 0) {
      actual_concurrent = Math.min(cfg.concurrentPerReplica, max_concurrent_per_replica);
    } else {
      actual_concurrent = 1;
      for (const B of candidates) if (reqTime(B) <= latencyBudgetS) actual_concurrent = B;
    }
    const slaInfeasible = reqTime(1) > latencyBudgetS;

    const step_s = stepTime(actual_concurrent);
    const batch_tps = actual_concurrent / step_s;
    const single_tps = 1 / stepTime(1);
    const compute_bound_tps = (compute_tflops * 1e12) / (2 * effective_params * 1e9);

    const time_per_req_prefill = avg_input_tokens / prefill_tps;
    const time_per_req_decode = avg_output_tokens * step_s;
    const time_per_req = time_per_req_prefill + time_per_req_decode;
    const rps_per_replica = actual_concurrent / time_per_req;

    const replicas_for_rps = Math.max(Math.ceil(provisionRPS / rps_per_replica), 1);
    const total_gpus = replicas_for_rps * tp;
    const total_hourly = total_gpus * gpu.hourly;

    // Memory- vs compute-bound at the chosen batch
    const t_mem_chosen = (weightReadGb(actual_concurrent) + actual_concurrent * kv_read_gb_per_stream_step) / effective_bw;
    const t_comp_chosen = (actual_concurrent * 2 * effective_params * 1e9) / (compute_tflops * 1e12);

    return {
      tp, replica_vram, vram_for_kv, max_concurrent_per_replica, actual_concurrent,
      effective_bw, compute_tflops, prefill_tps, single_tps, batch_tps, compute_bound_tps,
      time_per_req_prefill, time_per_req_decode, time_per_req, rps_per_replica,
      replicas_for_rps, total_gpus, total_hourly, slaInfeasible,
      isBWbound: t_mem_chosen >= t_comp_chosen,
    };
  };

  // v2 fix: search TP widths and pick the cheapest fleet, rather than always using the
  // minimum width that fits weights. Wider TP frees VRAM for KV (bigger batches, better
  // economics) and can be dramatically cheaper for long-context workloads.
  let sel = null;
  for (const tp of PRACTICAL_TP) {
    if (tp < raw_min) continue;
    const r = evalTP(tp);
    if (!r) continue;
    if (!sel || r.total_hourly < sel.total_hourly - 1e-9 ||
        (Math.abs(r.total_hourly - sel.total_hourly) < 1e-9 && r.time_per_req < sel.time_per_req)) sel = r;
  }
  if (!sel) throw new Error("Model does not fit on this GPU at any practical TP width");

  const {
    tp: gpus_per_replica, replica_vram, vram_for_kv, max_concurrent_per_replica,
    actual_concurrent, compute_tflops, prefill_tps, single_tps, batch_tps,
    compute_bound_tps, time_per_req_prefill, time_per_req_decode, time_per_req,
    rps_per_replica, replicas_for_rps, total_gpus, total_hourly, slaInfeasible, isBWbound,
  } = sel;

  // Active hours: GPUs run 24h but only serve traffic for activeHours
  const activeHours = cfg.activeHoursPerDay || 24;
  const total_daily = total_hourly * 24; // you pay for 24h regardless
  const total_monthly = total_daily * 30;

  // Tokens served (only during active hours)
  const tokens_per_req = avg_input_tokens + avg_output_tokens;
  const reqs_per_hour = cfg.targetRPS * 3600; // average RPS, not peak
  const tokens_per_hour = reqs_per_hour * tokens_per_req;
  const active_hours_month = activeHours * 30;
  const tokens_per_month = tokens_per_hour * active_hours_month;

  // Cost per token — based on what the fleet can actually serve at full utilization
  // The fleet serves tokens during active hours; cost is total_monthly / tokens_served_monthly
  const cost_per_1m_blended = tokens_per_month > 0 ? (total_monthly / tokens_per_month) * 1e6 : Infinity;

  // Separate input vs output cost (output costs more because decode is slower)
  // Approximate: output fraction of total compute time
  const decode_fraction = time_per_req > 0 ? (time_per_req_decode / time_per_req) : 0.5;
  const prefill_fraction = 1 - decode_fraction;
  const output_tokens_month = reqs_per_hour * avg_output_tokens * active_hours_month;
  const input_tokens_month = reqs_per_hour * avg_input_tokens * active_hours_month;
  const cost_per_1m_output_real = output_tokens_month > 0 ? (total_monthly * decode_fraction / output_tokens_month) * 1e6 : Infinity;
  const cost_per_1m_input_real = input_tokens_month > 0 ? (total_monthly * prefill_fraction / input_tokens_month) * 1e6 : Infinity;

  // idle_penalty is informational only (how much more you pay vs a hypothetical 24/7 service)
  const idle_penalty = 24 / activeHours;

  // Utilization: actual avg RPS vs what the fleet could handle
  const theoretical_max_rps = replicas_for_rps * rps_per_replica;
  const utilization_at_peak = provisionRPS / theoretical_max_rps;
  const utilization_at_avg = cfg.targetRPS / theoretical_max_rps;
  const utilization_with_hours = utilization_at_avg * (activeHours / 24);

  // Wasted spend: idle GPU hours per month
  const idle_hours_per_day = 24 - activeHours;
  const idle_cost_monthly = total_hourly * idle_hours_per_day * 30;
  const burst_headroom_pct = provisionRPS > 0 ? ((theoretical_max_rps - cfg.targetRPS) / cfg.targetRPS * 100) : 0;

  // Latency info
  const meetsLatencySLA = time_per_req * 1000 <= (cfg.latencyTargetMs || 99999);
  const ttft_ms = time_per_req_prefill * 1000;

  // Roofline (v2: includes KV-cache bytes in operational intensity, consistent with the
  // throughput engine; ridge point uses the same efficiency-adjusted compute and bandwidth)
  const moe_weight_read_gb = m.moe ? Math.min(m.params_b, m.active_params_b * actual_concurrent) * bytes_per_param : weight_gb;
  const bytes_per_step_gb = moe_weight_read_gb + actual_concurrent * kv_read_gb_per_stream_step;
  const oi = (2 * effective_params * 1e9 * actual_concurrent) / (bytes_per_step_gb * 1e9);
  const effective_bw_total = gpu.mem_bw * gpus_per_replica * 0.85;
  const ridgeOI = (compute_tflops * 1e12) / (effective_bw_total * 1e9);
  const attainableTFLOPS = Math.min(oi * effective_bw_total / 1000, compute_tflops);

  // Power (v2: +25% host/CPU/NIC overhead on top of GPU TDP; display applies PUE separately)
  const power_kw = (gpu.tdp * total_gpus * 1.25) / 1000;

  return {
    weight_gb, kv_per_req_gb, kv_bytes_per_token, min_gpus_weights, gpus_per_replica,
    max_concurrent_per_replica, actual_concurrent, single_tps, batch_tps,
    prefill_tps, compute_bound_tps, rps_per_replica, replicas_for_rps,
    total_gpus, total_hourly, total_daily, total_monthly,
    tokens_per_hour, tokens_per_month, cost_per_1m_blended,
    cost_per_1m_output: cost_per_1m_output_real, cost_per_1m_input: cost_per_1m_input_real,
    utilization: utilization_at_avg, utilization_at_peak, utilization_with_hours,
    theoretical_max_rps, time_per_req, oi, ridgeOI, isBWbound,
    attainableTFLOPS, compute_tflops: compute_tflops, power_kw,
    vram_for_kv, replica_vram, provisionRPS, peakMult,
    idle_cost_monthly, burst_headroom_pct, meetsLatencySLA, ttft_ms,
    slaInfeasible, activeHours, idle_penalty,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const fmt = (n, d = 2) => { if (n == null || isNaN(n) || !isFinite(n)) return "—"; if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"; return n.toFixed(d); };
const fmtUSD = (n) => { if (n == null || isNaN(n) || !isFinite(n)) return "—"; if (n === 0) return "Free"; if (n < 0.01) return "$" + n.toFixed(4); if (n < 0.1) return "$" + n.toFixed(3); if (n < 1) return "$" + n.toFixed(2); return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
const fmtBig = (n) => { if (n == null || isNaN(n) || !isFinite(n)) return "—"; if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"; if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"; return n.toFixed(0); };

// ─── UI Primitives ──────────────────────────────────────────────────────────

const F = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const S = "'IBM Plex Sans', system-ui, sans-serif";

function Metric({ label, value, sub, accent, warn }) {
  return (
    <div style={{ background: warn ? "rgba(248,113,113,0.06)" : "rgba(255,255,255,0.02)", border: `1px solid ${warn ? "rgba(248,113,113,0.15)" : "rgba(255,255,255,0.05)"}`, borderRadius: 8, padding: "10px 12px", flex: "1 1 145px", minWidth: 145 }}>
      <div style={{ fontSize: 10, color: warn ? "rgba(248,113,113,0.7)" : "rgba(255,255,255,0.35)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 2, fontFamily: F }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "#e2e8f0", fontFamily: F, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2, fontFamily: F }}>{sub}</div>}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function SliderField({ label, value, onChange, min, max, step = 1, fmtFn, hint }) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: "#6ee7b7", height: 3 }} />
        <span style={{ fontSize: 13, color: "#6ee7b7", fontFamily: F, fontWeight: 600, minWidth: 50, textAlign: "right" }}>{fmtFn ? fmtFn(value) : value}</span>
      </div>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}

function SelectField({ label, value, onChange, options, hint }) {
  return (
    <Field label={label}>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", padding: "7px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, color: "#e2e8f0", fontSize: 12, fontFamily: F, outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value} style={{ background: "#0b0b18" }}>{o.label}</option>)}
      </select>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}

function Bar({ value, max, color = "#6ee7b7", h = 6 }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100);
  return (<div style={{ width: "100%", height: h, background: "rgba(255,255,255,0.04)", borderRadius: h / 2, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: h / 2, transition: "width 0.3s" }} /></div>);
}

function Section({ title, children, style: s }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.015)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.04)", ...s }}>
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, fontFamily: F }}>{title}</div>
      {children}
    </div>
  );
}

// ─── Roofline SVG ───────────────────────────────────────────────────────────

function RooflineMini({ gpuKey, modelKey, quantKey, batchSize }) {
  const gpu = GPU_SPECS[gpuKey] || GPU_CATALOG[gpuKey]; const m = MODEL_PRESETS[modelKey]; const q = QUANT_LEVELS[quantKey];
  const ep = m.moe ? m.active_params_b : m.params_b;
  const peak = (q.bits <= 8 ? gpu.int8_tops : gpu.fp16_tflops) * 0.6;
  const bw = gpu.mem_bw * 0.85; const ridge = peak * 1000 / bw; // 85% achievable BW, consistent with engine
  const bp = q.bits / 8;
  const oi = (2 * ep * 1e9 * batchSize) / (ep * 1e9 * bp);
  const perf = Math.min(oi * bw / 1000, peak);
  const W = 440, H = 180, P = { t: 12, r: 16, b: 28, l: 44 };
  const pw = W - P.l - P.r, ph = H - P.t - P.b;
  const xMin = 0.3, xMax = 600, yMin = 1, yMax = peak * 2;
  const lx = v => P.l + (Math.log10(v) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin)) * pw;
  const ly = v => P.t + ph - (Math.log10(v) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin)) * ph;
  const pts = [];
  for (let i = 0; i <= 120; i++) { const x = Math.pow(10, Math.log10(xMin) + (Math.log10(xMax) - Math.log10(xMin)) * i / 120); const y = Math.min(x * bw / 1000, peak); if (y >= yMin) pts.push(`${lx(x).toFixed(1)},${ly(y).toFixed(1)}`); }
  const trail = [1, 2, 4, 8, 16, 32, 64, 128].map(bs => { const o = (2 * ep * 1e9 * bs) / (ep * 1e9 * bp); return { bs, x: lx(o), y: ly(Math.min(o * bw / 1000, peak)), active: bs === batchSize }; }).filter(d => d.x >= P.l && d.x <= W - P.r);
  const isBW = oi < ridge;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {[1, 10, 100, 1000].filter(v => v >= yMin && v <= yMax).map(v => <line key={v} x1={P.l} x2={W - P.r} y1={ly(v)} y2={ly(v)} stroke="rgba(255,255,255,0.03)" strokeWidth={0.5} />)}
      {[1, 10, 100].filter(v => v >= xMin && v <= xMax).map(v => <line key={v} x1={lx(v)} x2={lx(v)} y1={P.t} y2={P.t + ph} stroke="rgba(255,255,255,0.03)" strokeWidth={0.5} />)}
      {[1, 10, 100].map(v => <text key={`x${v}`} x={lx(v)} y={H - 6} textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize={8} fontFamily={F}>{v}</text>)}
      {[1, 10, 100, 1000].filter(v => v >= yMin && v <= yMax).map(v => <text key={`y${v}`} x={P.l - 5} y={ly(v) + 3} textAnchor="end" fill="rgba(255,255,255,0.2)" fontSize={8} fontFamily={F}>{v}</text>)}
      <text x={W / 2} y={H - 0} textAnchor="middle" fill="rgba(255,255,255,0.15)" fontSize={8} fontFamily={F}>FLOP/byte</text>
      <polyline points={pts.join(" ")} fill="none" stroke={isBW ? "rgba(110,231,183,0.5)" : "rgba(192,132,252,0.5)"} strokeWidth={2} />
      {trail.length > 1 && <polyline points={trail.map(d => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(" ")} fill="none" stroke="rgba(251,191,36,0.15)" strokeWidth={1} />}
      {trail.filter(d => !d.active).map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={2} fill="rgba(251,191,36,0.2)" />)}
      <line x1={lx(ridge)} x2={lx(ridge)} y1={P.t} y2={P.t + ph} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} strokeDasharray="3,3" />
      <circle cx={lx(oi)} cy={ly(perf)} r={5} fill="#fbbf24" stroke="#0b0b18" strokeWidth={2} />
      <text x={lx(oi) + 8} y={ly(perf) + 3} fill={isBW ? "#6ee7b7" : "#c084fc"} fontSize={8} fontFamily={F} fontWeight={600}>{isBW ? "mem-bound" : "compute-bound"}</text>
    </svg>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────

function App() {
  const [modelKey, setModelKey] = useState("70B");
  const [quantKey, setQuantKey] = useState("FP8");
  const [kvCacheDtype, setKvCacheDtype] = useState("FP16");
  const [targetRPS, setTargetRPS] = useState(10);
  const [avgSeqLen, setAvgSeqLen] = useState(2048);
  const [avgOutputTokens, setAvgOutputTokens] = useState(512);
  const [concurrentPerReplica, setConcurrentPerReplica] = useState(0);
  const [peakMultiplier, setPeakMultiplier] = useState(3);
  const [activeHoursPerDay, setActiveHoursPerDay] = useState(24);
  const [latencyTargetMs, setLatencyTargetMs] = useState(5000);
  const [pricingTier, setPricingTier] = useState("ondemand");
  const [providerFilter, setProviderFilter] = useState("all");
  const [sweepAxis, setSweepAxis] = useState("targetRPS");
  const [egressGbPerMonth, setEgressGbPerMonth] = useState(0);
  const [opsOverheadPct, setOpsOverheadPct] = useState(35);
  const [includeProviderCosts, setIncludeProviderCosts] = useState(true);

  // ── Auto-recommendation engine ──
  // Evaluate every instance × pricing tier and rank by monthly cost
  const allOptions = useMemo(() => {
    const tiers = pricingTier === "all" ? ["ondemand", "spot", "reserved1y"] : [pricingTier];
    const results = [];
    for (const ci of CLOUD_INSTANCES) {
      if (providerFilter !== "all" && ci.provider.toLowerCase() !== providerFilter) continue;
      const profile = PROVIDER_PROFILES[ci.provider] || { egressPerGb: 0, virtualizationOverhead: 0, crossAzPerGb: 0, storageIncluded: true, notes: "" };
      for (const tier of tiers) {
        const price = tier === "spot" ? ci.spot : tier === "reserved1y" ? ci.reserved1y : ci.ondemand;
        if (!price) continue;
        const perGpu = price / ci.gpus;
        const gpuSpec = GPU_SPECS[ci.gpu];
        if (!gpuSpec) continue;
        // Apply virtualization overhead: reduces effective throughput, increasing GPUs needed
        const virtAdjustedSpec = includeProviderCosts
          ? { ...gpuSpec, fp16_tflops: gpuSpec.fp16_tflops * (1 - profile.virtualizationOverhead), int8_tops: gpuSpec.int8_tops * (1 - profile.virtualizationOverhead), mem_bw: gpuSpec.mem_bw * (1 - profile.virtualizationOverhead) }
          : gpuSpec;
        const override = { ...virtAdjustedSpec, name: ci.gpu.replace("_", " "), hourly: perGpu, tdp: gpuSpec.tdp };
        try {
          const r = computeFleet({ model: modelKey, gpu: ci.gpu, quant: quantKey, kvCacheDtype, targetRPS, avgSeqLen, avgOutputTokens, concurrentPerReplica, peakMultiplier, activeHoursPerDay, latencyTargetMs, _gpuOverride: override });
          // Add provider-level extras
          const baseMonthly = r.total_monthly;
          const egressMonthly = includeProviderCosts ? egressGbPerMonth * profile.egressPerGb : 0;
          // Cross-AZ traffic only kicks in for multi-GPU replicas (model doesn't fit on one GPU)
          const crossAzGbMonthly = r.gpus_per_replica > 1 ? r.tokens_per_month * 0.000004 : 0; // ~4 bytes/token of inter-GPU traffic estimate
          const crossAzCost = includeProviderCosts ? crossAzGbMonthly * profile.crossAzPerGb : 0;
          // Storage (model weights need fast NVMe; ~$0.10/GB/mo for premium SSD if not included)
          const storageCost = (!profile.storageIncluded && includeProviderCosts) ? r.weight_gb * r.replicas_for_rps * 0.10 : 0;
          const totalInfraMonthly = baseMonthly + egressMonthly + crossAzCost + storageCost;
          // Ops overhead applied on top
          const opsCost = includeProviderCosts ? totalInfraMonthly * (opsOverheadPct / 100) : 0;
          const trueMonthly = totalInfraMonthly + opsCost;

          results.push({
            instance: ci, tier, perGpu, gpuSpec, profile,
            monthly: trueMonthly, baseMonthly, egressMonthly, crossAzCost, storageCost, opsCost,
            totalGpus: r.total_gpus, gpusPerReplica: r.gpus_per_replica,
            replicas: r.replicas_for_rps, costPerMOut: r.cost_per_1m_output * (trueMonthly / baseMonthly), costPerMIn: r.cost_per_1m_input * (trueMonthly / baseMonthly),
            util: r.utilization, utilPeak: r.utilization_at_peak, utilHours: r.utilization_with_hours,
            meetsLatency: r.meetsLatencySLA, latencyMs: r.time_per_req * 1000, ttftMs: r.ttft_ms,
            maxConcurrent: r.max_concurrent_per_replica, actualConcurrent: r.actual_concurrent,
            isBWbound: r.isBWbound, slaInfeasible: r.slaInfeasible, hourly: r.total_hourly,
            tps: r.batch_tps, provisionRPS: r.provisionRPS, theoreticalMaxRPS: r.theoretical_max_rps,
            weightGb: r.weight_gb, kvPerReqGb: r.kv_per_req_gb,
            replicaVram: r.replica_vram, vramForKv: r.vram_for_kv, powerKw: r.power_kw,
            idleCostMonthly: r.idle_cost_monthly, burstHeadroom: r.burst_headroom_pct,
            tokensPerMonth: r.tokens_per_month, result: r,
          });
        } catch {}
      }
    }
    return results.sort((a, b) => a.monthly - b.monthly);
  }, [modelKey, quantKey, kvCacheDtype, targetRPS, avgSeqLen, avgOutputTokens, concurrentPerReplica, peakMultiplier, activeHoursPerDay, latencyTargetMs, pricingTier, providerFilter, egressGbPerMonth, opsOverheadPct, includeProviderCosts]);

  const best = allOptions[0] || null;
  const result = best ? best.result : null;
  const activeInstance = best ? best.instance : CLOUD_INSTANCES[0];
  const effectiveGpuKey = best ? best.instance.gpu : "H100";
  const instanceGpuPrice = best ? best.perGpu : 2.99;
  const effectiveGpu = best ? { ...best.gpuSpec, name: best.instance.gpu.replace("_", " "), hourly: best.perGpu, tdp: best.gpuSpec.tdp } : GPU_SPECS.H100;

  const cfg = useMemo(() => ({ model: modelKey, gpu: effectiveGpuKey, quant: quantKey, kvCacheDtype, targetRPS, avgSeqLen, avgOutputTokens, concurrentPerReplica, peakMultiplier, activeHoursPerDay, latencyTargetMs, _gpuOverride: effectiveGpu }), [modelKey, effectiveGpuKey, quantKey, kvCacheDtype, targetRPS, avgSeqLen, avgOutputTokens, concurrentPerReplica, peakMultiplier, activeHoursPerDay, latencyTargetMs, instanceGpuPrice]);

  // Generalized parameter sweep
  const SWEEP_AXES = {
    targetRPS:       { label: "Requests/sec",   values: [1, 2, 5, 10, 20, 50, 100, 200, 500],       current: targetRPS,       fmt: v => v },
    avgSeqLen:       { label: "Input tokens",   values: [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768], current: avgSeqLen, fmt: v => v.toLocaleString() },
    avgOutputTokens: { label: "Output tokens",  values: [32, 64, 128, 256, 512, 1024, 2048, 4096],   current: avgOutputTokens, fmt: v => v },
    concurrentPerReplica: { label: "Batch size", values: [1, 2, 4, 8, 16, 32, 64, 128, 256],        current: concurrentPerReplica, fmt: v => v },
    peakMultiplier:  { label: "Peak ratio",     values: [1, 1.5, 2, 3, 4, 5, 8, 10],                 current: peakMultiplier,  fmt: v => v + "x" },
    activeHoursPerDay: { label: "Active hrs",   values: [4, 8, 10, 12, 16, 20, 24],                  current: activeHoursPerDay, fmt: v => v + "h" },
    latencyTargetMs: { label: "Latency SLA",    values: [500, 1000, 2000, 3000, 5000, 10000, 20000, 30000], current: latencyTargetMs, fmt: v => v >= 1000 ? (v/1000).toFixed(1) + "s" : v + "ms" },
  };

  const sweepData = useMemo(() => {
    const axis = SWEEP_AXES[sweepAxis];
    if (!axis) return [];
    return axis.values.map(v => {
      const overrideCfg = { ...cfg, [sweepAxis]: v };
      try {
        const r = computeFleet(overrideCfg);
        return { xVal: v, xLabel: axis.fmt(v), gpus: r.total_gpus, hourly: r.total_hourly, monthly: r.total_monthly, util: r.utilization, costPerMOut: r.cost_per_1m_output, isCurrent: v === axis.current };
      } catch { return null; }
    }).filter(Boolean);
  }, [cfg, sweepAxis, targetRPS, avgSeqLen, avgOutputTokens, concurrentPerReplica, peakMultiplier, activeHoursPerDay, latencyTargetMs]);

  // Top alternatives (different from best, deduplicated by provider+gpu)
  const alternatives = useMemo(() => {
    if (!best) return [];
    const seen = new Set();
    seen.add(`${best.instance.id}-${best.tier}`);
    return allOptions.filter(o => {
      const key = `${o.instance.id}-${o.tier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 12);
  }, [allOptions, best]);

  const gpu = effectiveGpu;
  const allProviders = ["all", ...new Set(CLOUD_INSTANCES.map(ci => ci.provider.toLowerCase()))];

  return (
    <div style={{ minHeight: "100vh", background: "#0b0b18", color: "#e2e8f0", fontFamily: S }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input[type=range]{-webkit-appearance:none;background:rgba(255,255,255,0.06);border-radius:3px;height:4px}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#6ee7b7;cursor:pointer;border:2px solid #0b0b18}
        select:focus{border-color:rgba(110,231,183,0.3)}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:2px}
      `}</style>

      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", fontFamily: F, lineHeight: 1.5 }}>
          Size the GPU fleet a given inference workload needs, and compare self-hosting against API pricing — with the commitment and ownership economics to decide reserved vs. spot vs. owned hardware.
          <span style={{ display: "block", fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 3 }}>KV-aware roofline · TP search · commitment economics · pricing snapshots Apr 2026</span>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap" }}>
        <div style={{ width: 280, padding: "16px 16px", borderRight: "1px solid rgba(255,255,255,0.04)", background: "rgba(255,255,255,0.005)", flexShrink: 0, overflowY: "auto" }}>

          {/* Workload presets */}
          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>Quick presets</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 14 }}>
            {[
              { label: "Chat app", tip: "Consumer chat, bursty traffic", model: "8B", quant: "FP8", rps: 20, peak: 5, hours: 16, latency: 3000, seqIn: 1024, seqOut: 256, batch: 0 },
              { label: "AI agents", tip: "High-volume agent orchestration", model: "70B", quant: "INT4", rps: 100, peak: 1.5, hours: 24, latency: 30000, seqIn: 8192, seqOut: 2048, batch: 0 },
              { label: "Enterprise", tip: "Internal copilot, business hours", model: "70B", quant: "FP8", rps: 5, peak: 3, hours: 10, latency: 5000, seqIn: 4096, seqOut: 512, batch: 0 },
              { label: "Startup MVP", tip: "Low traffic, cost-sensitive", model: "8B", quant: "INT4", rps: 2, peak: 3, hours: 24, latency: 10000, seqIn: 2048, seqOut: 512, batch: 0 },
              { label: "Batch / offline", tip: "Nightly batch processing", model: "70B", quant: "INT4", rps: 50, peak: 1, hours: 8, latency: 30000, seqIn: 16384, seqOut: 4096, batch: 0 },
            ].map(p => (
              <button key={p.label} onClick={() => {
                setModelKey(p.model); setQuantKey(p.quant); setTargetRPS(p.rps); setPeakMultiplier(p.peak);
                setActiveHoursPerDay(p.hours); setLatencyTargetMs(p.latency); setAvgSeqLen(p.seqIn);
                setAvgOutputTokens(p.seqOut); setConcurrentPerReplica(p.batch);
              }} title={p.tip} style={{
                padding: "4px 8px", fontSize: 9, fontFamily: F, border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 4, cursor: "pointer", background: "rgba(255,255,255,0.03)", color: "rgba(255,255,255,0.5)",
                transition: "all 0.15s",
              }}>{p.label}</button>
            ))}
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.04)", margin: "0 0 14px" }} />

          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>1. Your model</div>
          <SelectField label="Model size" value={modelKey} onChange={setModelKey} options={Object.entries(MODEL_PRESETS).map(([k, v]) => ({ value: k, label: v.name }))} hint="Determines weight memory + compute per token" />
          <SelectField label="Quantization" value={quantKey} onChange={setQuantKey} options={Object.entries(QUANT_LEVELS).map(([k, v]) => ({ value: k, label: v.label }))} hint="Lower bits = less VRAM, more throughput, slight quality loss" />
          <SelectField label="KV cache dtype" value={kvCacheDtype} onChange={setKvCacheDtype} options={[{ value: "FP16", label: "FP16 (default)" }, { value: "FP8", label: "FP8 (halves KV memory)" }]} hint="Independent of weight quant — FP8 KV doubles concurrent capacity with minimal quality loss" />

          <div style={{ height: 1, background: "rgba(255,255,255,0.04)", margin: "16px 0" }} />

          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>2. Your traffic</div>
          <SliderField label="Avg requests/sec" value={targetRPS} onChange={setTargetRPS} min={1} max={500} step={1} hint="Average sustained request rate across the day" />
          <SliderField label="Peak / avg ratio" value={peakMultiplier} onChange={setPeakMultiplier} min={1} max={10} step={0.5} fmtFn={v => v + "x"} hint="Peak traffic vs average — provision for the burst" />
          <SliderField label="Active hours / day" value={activeHoursPerDay} onChange={setActiveHoursPerDay} min={1} max={24} step={1} fmtFn={v => v + "h"} hint="Hours with real traffic — you still pay for 24h GPU" />
          <SliderField label="Latency SLA" value={latencyTargetMs} onChange={setLatencyTargetMs} min={500} max={30000} step={500} fmtFn={v => v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms"} hint="Max acceptable total response time (TTFT + decode)" />

          <div style={{ height: 1, background: "rgba(255,255,255,0.04)", margin: "12px 0" }} />

          <SliderField label="Avg input tokens" value={avgSeqLen} onChange={setAvgSeqLen} min={64} max={32768} step={64} fmtFn={v => v.toLocaleString()} hint="How long the average prompt/context is" />
          <SliderField label="Avg output tokens" value={avgOutputTokens} onChange={setAvgOutputTokens} min={32} max={4096} step={32} hint="How many tokens the model generates per request" />
          <div style={{ marginBottom: 8 }}>
            <SliderField label="Batch per replica" value={concurrentPerReplica} onChange={setConcurrentPerReplica} min={0} max={256} step={1} fmtFn={v => v === 0 ? "Auto" : v} hint="Concurrent requests per GPU. Set to 0 (Auto) to optimize per model — bigger models get bigger batches to saturate the GPU." />
            <button onClick={() => setConcurrentPerReplica(concurrentPerReplica === 0 ? 32 : 0)} style={{
              marginTop: 4, padding: "3px 8px", fontSize: 9, fontFamily: F, border: "1px solid",
              borderColor: concurrentPerReplica === 0 ? "rgba(110,231,183,0.3)" : "rgba(255,255,255,0.1)",
              borderRadius: 4, cursor: "pointer",
              background: concurrentPerReplica === 0 ? "rgba(110,231,183,0.1)" : "transparent",
              color: concurrentPerReplica === 0 ? "#6ee7b7" : "rgba(255,255,255,0.4)", fontWeight: 600,
            }}>{concurrentPerReplica === 0 ? "✓ Auto-batch (optimized per model)" : "Use auto-batch"}</button>
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.04)", margin: "16px 0" }} />

          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>3. Preferences</div>
          <SelectField label="Pricing tier" value={pricingTier} onChange={setPricingTier} options={[
            { value: "ondemand", label: "On-demand (no commitment)" },
            { value: "spot", label: "Spot / preemptible (cheapest, interruptible)" },
            { value: "reserved1y", label: "1-year reserved (committed)" },
            { value: "all", label: "Show best across all tiers" },
          ]} hint="Spot is cheapest but can be interrupted. Reserved requires commitment." />
          <SelectField label="Cloud provider" value={providerFilter} onChange={setProviderFilter} options={allProviders.map(p => ({ value: p, label: p === "all" ? "Any provider" : p.charAt(0).toUpperCase() + p.slice(1) }))} hint="Filter to a specific cloud provider or see all" />

          <div style={{ height: 1, background: "rgba(255,255,255,0.04)", margin: "12px 0" }} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em" }}>True cost mode</span>
            <button onClick={() => setIncludeProviderCosts(!includeProviderCosts)} style={{
              background: includeProviderCosts ? "rgba(110,231,183,0.15)" : "rgba(255,255,255,0.05)", border: "1px solid", borderColor: includeProviderCosts ? "rgba(110,231,183,0.3)" : "rgba(255,255,255,0.1)",
              color: includeProviderCosts ? "#6ee7b7" : "rgba(255,255,255,0.4)", borderRadius: 4, padding: "3px 9px", fontSize: 9, fontFamily: F, cursor: "pointer", fontWeight: 600,
            }}>{includeProviderCosts ? "ON" : "OFF"}</button>
          </div>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: F, marginBottom: 10, lineHeight: 1.4 }}>
            Includes egress fees, virtualization overhead, cross-AZ traffic, storage, and ops cost for an honest TCO comparison
          </div>

          {includeProviderCosts && (<>
            <SliderField label="Engineering ops overhead" value={opsOverheadPct} onChange={setOpsOverheadPct} min={0} max={100} step={5} fmtFn={v => v + "%"} hint="Cost of engineers managing infra (35% typical for small teams, less at scale)" />
            <SliderField label="Egress traffic" value={egressGbPerMonth} onChange={setEgressGbPerMonth} min={0} max={50000} step={100} fmtFn={v => v.toLocaleString() + " GB/mo"} hint="Data sent out to internet/users — hyperscalers charge $0.05–$0.09/GB, specialists charge $0" />
          </>)}

          {best && (
            <div style={{ background: "rgba(110,231,183,0.04)", borderRadius: 6, padding: "8px 10px", border: "1px solid rgba(110,231,183,0.1)", marginTop: 8, fontSize: 10, fontFamily: F, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>
              <div style={{ fontSize: 9, color: "rgba(110,231,183,0.5)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>Recommended</div>
              <div><span style={{ color: "#6ee7b7", fontWeight: 600 }}>{best.instance.provider} {best.instance.gpu.replace("_"," ")}</span></div>
              <div>{best.instance.instance}</div>
              <div>${best.perGpu.toFixed(2)}/GPU/hr ({best.tier}) · {best.instance.region}</div>
              <div style={{ marginTop: 2, color: "rgba(255,255,255,0.25)" }}>{allOptions.length} configurations evaluated</div>
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Results ═══ */}
        <div style={{ flex: 1, padding: "16px 20px", minWidth: 0, overflowY: "auto" }}>
          {result && best ? (<>
            {/* ── The Answer ── */}
            <div style={{ background: "rgba(110,231,183,0.04)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 10, color: "rgba(110,231,183,0.6)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.08em" }}>Recommended</div>
                  <div style={{ fontSize: 36, fontWeight: 700, color: "#6ee7b7", fontFamily: F, lineHeight: 1 }}>{best.totalGpus} <span style={{ fontSize: 16, fontWeight: 500, color: "rgba(110,231,183,0.7)" }}>{best.instance.gpu.replace("_"," ")}s</span></div>
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", fontFamily: F, lineHeight: 1.6 }}>
                  {best.replicas} replica{best.replicas > 1 ? "s" : ""} × {best.gpusPerReplica} GPU{best.gpusPerReplica > 1 ? "s" : ""}/replica
                  <br /><span style={{ color: "#6ee7b7" }}>{best.instance.provider}</span> {best.instance.instance} @ <span style={{ color: "#fbbf24" }}>${best.perGpu.toFixed(2)}/GPU/hr</span> ({best.tier})
                  <br /><span style={{ color: "rgba(255,255,255,0.25)" }}>{best.instance.region} · avg {targetRPS} req/s · peak {best.provisionRPS} req/s · {activeHoursPerDay}h/day</span>
                  {alternatives.length > 0 && <><br /><span style={{ color: "rgba(255,255,255,0.2)" }}>Cheapest of {allOptions.length} configs evaluated · {alternatives.length > 1 && `#2 is ${((alternatives[0].monthly / best.monthly - 1) * 100).toFixed(0)}% more`}</span></>}
                </div>
              </div>
              {result.slaInfeasible && (
                <div style={{ marginTop: 8, fontSize: 10, fontFamily: F, color: "#f87171", background: "rgba(248,113,113,0.06)", padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(248,113,113,0.12)" }}>
                  Latency SLA ({latencyTargetMs >= 1000 ? (latencyTargetMs / 1000).toFixed(1) + "s" : latencyTargetMs + "ms"}) is infeasible on this hardware even at batch=1 ({(result.time_per_req * 1000).toFixed(0)}ms/req). More replicas cannot fix service time — use a smaller/more quantized model, shorter outputs, or faster GPUs.
                </div>
              )}
              {!result.slaInfeasible && concurrentPerReplica === 0 && result.actual_concurrent < result.max_concurrent_per_replica && (
                <div style={{ marginTop: 8, fontSize: 10, fontFamily: F, color: "rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.02)", padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.05)" }}>
                  Auto-batch capped at {result.actual_concurrent} (VRAM fits {result.max_concurrent_per_replica}) to meet the {latencyTargetMs >= 1000 ? (latencyTargetMs / 1000).toFixed(1) + "s" : latencyTargetMs + "ms"} SLA — larger batches slow per-stream decode via KV-cache bandwidth
                </div>
              )}
            </div>

            {/* ── Key Numbers ── */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              <Metric label={includeProviderCosts ? "Monthly TCO" : "Monthly cost"} value={`$${(best ? best.monthly : result.total_monthly).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} accent="#f87171" sub={includeProviderCosts && best && best.baseMonthly < best.monthly ? `$${best.baseMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })} GPU + $${(best.monthly - best.baseMonthly).toLocaleString(undefined, { maximumFractionDigits: 0 })} extras` : (activeHoursPerDay < 24 ? `incl. $${result.idle_cost_monthly.toLocaleString(undefined, { maximumFractionDigits: 0 })} idle (${24 - activeHoursPerDay}h/day)` : `$${result.total_hourly.toFixed(0)}/hr · $${result.total_daily.toFixed(0)}/day`)} />
              <Metric label="Cost / 1M output" value={fmtUSD(result.cost_per_1m_output)} accent="#fbbf24" sub={result.idle_penalty > 1 ? `${result.idle_penalty.toFixed(1)}x idle penalty baked in` : `input: ${fmtUSD(result.cost_per_1m_input)}/1M`} />
              <Metric label="Utilization (avg)" value={`${(result.utilization * 100).toFixed(0)}%`} accent={result.utilization > 0.85 ? "#f87171" : result.utilization > 0.6 ? "#fbbf24" : result.utilization < 0.3 ? "#f87171" : "#6ee7b7"} sub={`peak: ${(result.utilization_at_peak * 100).toFixed(0)}% · with idle: ${(result.utilization_with_hours * 100).toFixed(0)}%`} warn={result.utilization_at_peak > 0.9 || result.utilization_with_hours < 0.15} />
              <Metric label="Latency / req" value={`${(result.time_per_req * 1000).toFixed(0)}ms`} accent={result.meetsLatencySLA ? "#c4b5fd" : "#f87171"} sub={result.meetsLatencySLA ? `TTFT: ${result.ttft_ms.toFixed(0)}ms` : `exceeds ${latencyTargetMs}ms SLA`} warn={!result.meetsLatencySLA} />
              <Metric label="Burst headroom" value={`${result.burst_headroom_pct.toFixed(0)}%`} accent={result.burst_headroom_pct < 20 ? "#f87171" : result.burst_headroom_pct > 200 ? "#fb923c" : "#6ee7b7"} sub={`max ${result.theoretical_max_rps.toFixed(1)} req/s capacity`} warn={result.burst_headroom_pct < 20} />
              <Metric label="Power draw" value={`${result.power_kw.toFixed(1)} kW`} sub={`$${(result.power_kw * 1.2 * 0.08 * 24 * 30).toFixed(0)}/mo @ $0.08/kWh`} />
            </div>

            {/* ── True cost breakdown ── */}
            {includeProviderCosts && best && (best.egressMonthly + best.crossAzCost + best.storageCost + best.opsCost > 0) && (
              <Section title={`Monthly cost breakdown — ${best.instance.provider}`} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", gap: 1, marginBottom: 8 }}>
                  <div style={{ width: `${(best.baseMonthly / best.monthly * 100)}%`, background: "#6ee7b7", minWidth: 2 }} title={`GPU: $${best.baseMonthly.toFixed(0)}`} />
                  {best.egressMonthly > 0 && <div style={{ width: `${(best.egressMonthly / best.monthly * 100)}%`, background: "#f87171", minWidth: 2 }} title={`Egress: $${best.egressMonthly.toFixed(0)}`} />}
                  {best.crossAzCost > 0 && <div style={{ width: `${(best.crossAzCost / best.monthly * 100)}%`, background: "#fb923c", minWidth: 2 }} title={`Cross-AZ: $${best.crossAzCost.toFixed(0)}`} />}
                  {best.storageCost > 0 && <div style={{ width: `${(best.storageCost / best.monthly * 100)}%`, background: "#fbbf24", minWidth: 2 }} title={`Storage: $${best.storageCost.toFixed(0)}`} />}
                  {best.opsCost > 0 && <div style={{ width: `${(best.opsCost / best.monthly * 100)}%`, background: "#c084fc", minWidth: 2 }} title={`Ops: $${best.opsCost.toFixed(0)}`} />}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 10, fontFamily: F }}>
                  <span style={{ color: "#6ee7b7" }}>■ GPU compute: <span style={{ color: "rgba(255,255,255,0.6)" }}>${best.baseMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> ({(best.baseMonthly / best.monthly * 100).toFixed(0)}%)</span>
                  {best.egressMonthly > 0 && <span style={{ color: "#f87171" }}>■ Egress fees: <span style={{ color: "rgba(255,255,255,0.6)" }}>${best.egressMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> ({(best.egressMonthly / best.monthly * 100).toFixed(0)}%)</span>}
                  {best.crossAzCost > 0 && <span style={{ color: "#fb923c" }}>■ Cross-AZ traffic: <span style={{ color: "rgba(255,255,255,0.6)" }}>${best.crossAzCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></span>}
                  {best.storageCost > 0 && <span style={{ color: "#fbbf24" }}>■ Storage (NVMe): <span style={{ color: "rgba(255,255,255,0.6)" }}>${best.storageCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></span>}
                  {best.opsCost > 0 && <span style={{ color: "#c084fc" }}>■ Engineering ops: <span style={{ color: "rgba(255,255,255,0.6)" }}>${best.opsCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> ({opsOverheadPct}%)</span>}
                </div>
                <div style={{ marginTop: 10, fontSize: 10, fontFamily: F, color: "rgba(255,255,255,0.3)", lineHeight: 1.6 }}>
                  <div><span style={{ color: "rgba(255,255,255,0.5)" }}>{best.instance.provider}</span> profile: {best.profile.notes}</div>
                  <div>Virtualization overhead: {(best.profile.virtualizationOverhead * 100).toFixed(0)}% (reduces effective throughput, increasing GPUs needed) · Egress: ${best.profile.egressPerGb.toFixed(3)}/GB</div>
                </div>
              </Section>
            )}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <Section title="VRAM per replica" style={{ flex: "1 1 220px" }}>
                <div style={{ display: "flex", height: 16, borderRadius: 4, overflow: "hidden", gap: 2, marginBottom: 6 }}>
                  <div style={{ width: `${(result.weight_gb / result.replica_vram * 100)}%`, background: "#6ee7b7", borderRadius: 3, minWidth: 2 }} title={`Weights: ${fmt(result.weight_gb, 1)} GB`} />
                  <div style={{ width: `${(result.kv_per_req_gb * result.actual_concurrent / result.replica_vram * 100)}%`, background: "#67e8f9", borderRadius: 3, minWidth: 2 }} title={`KV cache`} />
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 10, fontFamily: F, color: "rgba(255,255,255,0.35)", flexWrap: "wrap" }}>
                  <span><span style={{ color: "#6ee7b7" }}>■</span> Weights: {fmt(result.weight_gb, 1)}GB</span>
                  <span><span style={{ color: "#67e8f9" }}>■</span> KV cache: {fmt(result.kv_per_req_gb * result.actual_concurrent, 1)}GB ({result.actual_concurrent} reqs)</span>
                  <span>Free: {fmt(result.vram_for_kv - result.kv_per_req_gb * result.actual_concurrent, 1)}GB</span>
                  <span>Total: {fmt(result.replica_vram, 0)}GB ({result.gpus_per_replica}×{gpu.vram}GB)</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 10, fontFamily: F, color: "rgba(255,255,255,0.3)" }}>
                  Max concurrent per replica: <span style={{ color: "#6ee7b7", fontWeight: 600 }}>{result.max_concurrent_per_replica}</span> requests (KV-limited)
                  {concurrentPerReplica === 0 && <> · <span style={{ color: "#fbbf24" }}>auto-batch picked: {result.actual_concurrent}</span></>}
                </div>
              </Section>

              <Section title="Roofline position" style={{ flex: "1 1 280px" }}>
                <RooflineMini gpuKey={effectiveGpuKey} modelKey={modelKey} quantKey={quantKey} batchSize={result.actual_concurrent} />
              </Section>
            </div>

            {/* ── Cost sensitivity: sweep any parameter ── */}
            <Section title="How cost changes when you adjust..." style={{ marginBottom: 16 }}>
              {/* Toggle buttons */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                {Object.entries(SWEEP_AXES).map(([key, axis]) => (
                  <button key={key} onClick={() => setSweepAxis(key)} style={{
                    padding: "4px 10px", fontSize: 9, fontFamily: F, borderRadius: 4, cursor: "pointer", border: "1px solid", transition: "all 0.15s",
                    background: sweepAxis === key ? "rgba(110,231,183,0.12)" : "transparent",
                    color: sweepAxis === key ? "#6ee7b7" : "rgba(255,255,255,0.35)",
                    borderColor: sweepAxis === key ? "rgba(110,231,183,0.25)" : "rgba(255,255,255,0.06)",
                    fontWeight: sweepAxis === key ? 600 : 400,
                  }}>{axis.label}</button>
                ))}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                  <thead><tr>
                    {[SWEEP_AXES[sweepAxis]?.label || "Value", "GPUs", "$/hr", "$/month", "$/1M out", "Util"].map((h, i) => (
                      <th key={h} style={{ padding: "5px 8px", textAlign: i === 0 ? "left" : "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {sweepData.map((s, i) => (
                      <tr key={s.xVal} style={{ background: s.isCurrent ? "rgba(110,231,183,0.05)" : i % 2 ? "rgba(255,255,255,0.008)" : "transparent" }}>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: s.isCurrent ? "#6ee7b7" : "#cbd5e1", fontWeight: s.isCurrent ? 600 : 400 }}>
                          {s.xLabel} {s.isCurrent && <span style={{ fontSize: 7, color: "rgba(110,231,183,0.5)", marginLeft: 4 }}>current</span>}
                        </td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "#c4b5fd" }}>{s.gpus}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "rgba(255,255,255,0.5)" }}>${s.hourly.toFixed(0)}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: s.isCurrent ? "#6ee7b7" : "#f87171" }}>${s.monthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "#fbbf24" }}>{fmtUSD(s.costPerMOut)}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right" }}>
                          <span style={{ color: s.util > 0.85 ? "#f87171" : s.util < 0.3 ? "#fb923c" : "#6ee7b7" }}>{(s.util * 100).toFixed(0)}%</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6 }}>
                {sweepAxis === "targetRPS" && "GPUs jump in steps — sweet spots are where utilization is 50-80%."}
                {sweepAxis === "avgSeqLen" && "Longer context = more KV cache memory = fewer concurrent requests per replica."}
                {sweepAxis === "avgOutputTokens" && "More output tokens = more decode time per request = lower effective RPS per replica."}
                {sweepAxis === "concurrentPerReplica" && "Higher batch improves GPU utilization until you hit VRAM or compute limits."}
                {sweepAxis === "peakMultiplier" && "Higher peak ratio = more GPUs provisioned for burst headroom."}
                {sweepAxis === "activeHoursPerDay" && "Fewer active hours means paying for idle GPUs — per-token cost rises."}
                {sweepAxis === "latencyTargetMs" && "Tighter latency SLA forces smaller batches (faster per-stream decode) — throughput per replica drops, so more replicas are needed."}
              </div>
            </Section>

            {/* ── Ranked alternatives ── */}
            <Section title={`All ${allOptions.length} options ranked by monthly cost`} style={{ marginBottom: 16 }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                  <thead><tr>
                    {["#", "Provider", "GPU", "Instance", "Tier", "$/GPU/hr", "GPUs", "$/month", "$/1M out", "vs best"].map((h, hi) => (
                      <th key={h} style={{ padding: "5px 8px", textAlign: hi < 4 ? "left" : "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {/* Best option */}
                    {best && (
                      <tr style={{ background: "rgba(110,231,183,0.06)" }}>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", color: "#6ee7b7", fontWeight: 700 }}>1</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", color: "#6ee7b7", fontWeight: 600 }}>{best.instance.provider}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", color: "#6ee7b7" }}>{best.instance.gpu.replace("_"," ")}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", color: "rgba(110,231,183,0.6)", fontSize: 9 }}>{best.instance.instance}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", textAlign: "right", color: "rgba(110,231,183,0.5)", fontSize: 9 }}>{best.tier}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", textAlign: "right", color: "#67e8f9" }}>${best.perGpu.toFixed(2)}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", textAlign: "right", color: "#c4b5fd" }}>{best.totalGpus}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", textAlign: "right", color: "#34d399", fontWeight: 600 }}>${best.monthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", textAlign: "right", color: "#fbbf24" }}>{fmtUSD(best.costPerMOut)}</td>
                        <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.03)", textAlign: "right", color: "#6ee7b7", fontWeight: 600 }}>best</td>
                      </tr>
                    )}
                    {/* Alternatives */}
                    {alternatives.map((o, i) => {
                      const pctMore = best ? ((o.monthly / best.monthly - 1) * 100) : 0;
                      return (
                        <tr key={`${o.instance.id}-${o.tier}`} style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.3)" }}>{i + 2}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: "#cbd5e1" }}>{o.instance.provider}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.5)" }}>{o.instance.gpu.replace("_"," ")}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.3)", fontSize: 9 }}>{o.instance.instance}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "rgba(255,255,255,0.25)", fontSize: 9 }}>{o.tier}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "#67e8f9" }}>${o.perGpu.toFixed(2)}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "#c4b5fd" }}>{o.totalGpus}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "#f87171" }}>${o.monthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "#fbbf24" }}>{fmtUSD(o.costPerMOut)}</td>
                          <td style={{ padding: "4px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: pctMore < 20 ? "rgba(255,255,255,0.4)" : pctMore < 100 ? "#fb923c" : "#f87171" }}>+{pctMore.toFixed(0)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6 }}>
                Prices from cloudprice.net (Azure, AWS, GCP) and provider pricing pages, Apr 2026. Same workload evaluated across all {CLOUD_INSTANCES.length} instances × pricing tiers. "vs best" shows how much more each alternative costs monthly.
              </div>
            </Section>

            {/* ── NEW in v2: Commitment & ownership economics ── */}
            {best && (() => {
              const inst = best.instance;
              const gpus = best.totalGpus;
              const od = inst.ondemand ? inst.ondemand / inst.gpus : null;
              const sp = inst.spot ? inst.spot / inst.gpus : null;
              const rv = inst.reserved1y ? inst.reserved1y / inst.gpus : null;

              // Blended portfolio: base-load fleet (avg RPS) on reserved, burst fleet on spot/on-demand
              const baseReplicas = Math.max(Math.ceil(targetRPS / best.result.rps_per_replica), 1);
              const baseGpus = Math.min(baseReplicas * best.gpusPerReplica, gpus);
              const burstGpus = gpus - baseGpus;
              const burstRate = sp ?? od;
              const burstDuty = 0.25; // assume burst capacity actually runs ~25% of active hours (autoscaled)
              const monthlyAllOd = od ? gpus * od * 24 * 30 : null;
              const monthlyAllRv = rv ? gpus * rv * 24 * 30 : null;
              const monthlyBlended = (rv && burstRate != null)
                ? baseGpus * rv * 24 * 30 + burstGpus * burstRate * activeHoursPerDay * burstDuty * 30
                : null;
              const breakEvenUtil = (rv && od) ? rv / od : null;

              // Owned / colo economics → effective $/GPU-hr
              const PURCHASE = { H100: 27500, H200: 32000, B200: 40000, A100_80: 17000, A100_40: 10000, L40S: 11000, L4: 2500 };
              const buyPrice = PURCHASE[inst.gpu] || 25000;
              const serverOverhead = 1.35;      // chassis, CPU, NIC, IB fabric share
              const deprMonths = 36;            // straight-line
              const kwPerGpu = (best.gpuSpec.tdp * 1.25) / 1000;  // +25% host overhead
              const powerHr = kwPerGpu * 1.2 * 0.08;              // PUE 1.2 × $0.08/kWh
              const coloHr = kwPerGpu * 140 / 730;                // $140/kW-month colo
              const capexHr = (buyPrice * serverOverhead) / (deprMonths * 730);
              const ownHr = capexHr + powerHr + coloHr;
              const monthlyOwn = gpus * ownHr * 24 * 30;
              const ownBreakEvenMo = od ? (buyPrice * serverOverhead * gpus) / Math.max((od - powerHr - coloHr) * gpus * 730, 1) : null;

              const rows = [
                od != null && { label: "All on-demand", rate: od, monthly: monthlyAllOd, note: "Zero commitment — pay for flexibility" },
                rv != null && { label: "All reserved (1yr)", rate: rv, monthly: monthlyAllRv, note: `Breaks even vs on-demand if fleet persists ≥ ${(breakEvenUtil * 100).toFixed(0)}% of the year` },
                monthlyBlended != null && { label: `Blended: ${baseGpus} reserved + ${burstGpus} burst`, rate: null, monthly: monthlyBlended, note: `Base load reserved, burst on ${sp ? "spot" : "on-demand"} @ ${(burstDuty * 100).toFixed(0)}% duty cycle` },
                { label: "Own hardware (colo)", rate: ownHr, monthly: monthlyOwn, note: `$${buyPrice.toLocaleString()}/GPU × ${serverOverhead}x system, ${deprMonths}-mo depreciation, $0.08/kWh, $140/kW-mo colo${ownBreakEvenMo ? ` · pays back vs on-demand in ~${Math.ceil(ownBreakEvenMo)} mo` : ""}` },
              ].filter(Boolean).sort((a, b) => a.monthly - b.monthly);

              const cheapest = rows[0];
              return (
                <Section title={`Commitment & ownership economics — ${gpus}× ${inst.gpu.replace("_", " ")} fleet`} style={{ marginBottom: 16 }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                      <thead><tr>
                        {["Structure", "$/GPU/hr", "$/month", "vs cheapest", "Notes"].map((h, i) => (
                          <th key={h} style={{ padding: "5px 8px", textAlign: i === 0 || i === 4 ? "left" : "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={r.label} style={{ background: i === 0 ? "rgba(110,231,183,0.05)" : i % 2 ? "rgba(255,255,255,0.008)" : "transparent" }}>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: i === 0 ? "#6ee7b7" : "#cbd5e1", fontWeight: i === 0 ? 600 : 400 }}>{r.label}</td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "#67e8f9" }}>{r.rate != null ? "$" + r.rate.toFixed(2) : "mixed"}</td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: i === 0 ? "#34d399" : "#f87171", fontWeight: i === 0 ? 600 : 400 }}>${r.monthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: i === 0 ? "#6ee7b7" : "rgba(255,255,255,0.4)" }}>{i === 0 ? "best" : "+" + ((r.monthly / cheapest.monthly - 1) * 100).toFixed(0) + "%"}</td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: "rgba(255,255,255,0.3)", fontSize: 9 }}>{r.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6, lineHeight: 1.6 }}>
                    GPU-hours only (excludes egress/storage/ops shown above). Reserved break-even = reserved-rate ÷ on-demand-rate: below that fleet-retention level, commitment loses money. Ownership assumes {deprMonths}-month straight-line depreciation with zero residual — conservative; H100s have retained meaningful resale value. Burst duty cycle (25%) and purchase prices are editable assumptions in the source.
                  </div>
                </Section>
              );
            })()}
            {(() => {
              const outputTokensPerMonth = targetRPS * 3600 * activeHoursPerDay * 30 * avgOutputTokens;
              const inputTokensPerMonth = targetRPS * 3600 * activeHoursPerDay * 30 * avgSeqLen;

              // Helper: find cheapest self-host TCO for a specific model
              // (re-runs the recommendation engine with a different model key)
              const cheapestSelfHostFor = (modelKeyOverride, rpsOverride) => {
                const tiers = pricingTier === "all" ? ["ondemand", "spot", "reserved1y"] : [pricingTier];
                let cheapest = null;
                for (const ci of CLOUD_INSTANCES) {
                  if (providerFilter !== "all" && ci.provider.toLowerCase() !== providerFilter) continue;
                  const profile = PROVIDER_PROFILES[ci.provider] || { egressPerGb: 0, virtualizationOverhead: 0, crossAzPerGb: 0, storageIncluded: true };
                  for (const tier of tiers) {
                    const price = tier === "spot" ? ci.spot : tier === "reserved1y" ? ci.reserved1y : ci.ondemand;
                    if (!price) continue;
                    const perGpu = price / ci.gpus;
                    const gpuSpec = GPU_SPECS[ci.gpu];
                    if (!gpuSpec) continue;
                    const virtAdjusted = includeProviderCosts
                      ? { ...gpuSpec, fp16_tflops: gpuSpec.fp16_tflops * (1 - profile.virtualizationOverhead), int8_tops: gpuSpec.int8_tops * (1 - profile.virtualizationOverhead), mem_bw: gpuSpec.mem_bw * (1 - profile.virtualizationOverhead) }
                      : gpuSpec;
                    const override = { ...virtAdjusted, name: ci.gpu.replace("_", " "), hourly: perGpu, tdp: gpuSpec.tdp };
                    try {
                      const r = computeFleet({ ...cfg, model: modelKeyOverride, gpu: ci.gpu, _gpuOverride: override, targetRPS: rpsOverride !== undefined ? rpsOverride : cfg.targetRPS });
                      const baseMonthly = r.total_monthly;
                      const egress = includeProviderCosts ? egressGbPerMonth * profile.egressPerGb : 0;
                      const crossAz = includeProviderCosts && r.gpus_per_replica > 1 ? r.tokens_per_month * 0.000004 * profile.crossAzPerGb : 0;
                      const storage = (!profile.storageIncluded && includeProviderCosts) ? r.weight_gb * r.replicas_for_rps * 0.10 : 0;
                      const infra = baseMonthly + egress + crossAz + storage;
                      const opsRate = includeProviderCosts ? (opsOverheadPct / 100) : 0.35;
                      const tco = infra * (1 + opsRate);
                      if (!cheapest || tco < cheapest.tco) {
                        cheapest = { tco, baseMonthly, instance: ci, tier, gpus: r.total_gpus, perGpu };
                      }
                    } catch {}
                  }
                }
                return cheapest;
              };

              const apiComparisons = API_BENCHMARKS.map(api => {
                const apiMonthly = (outputTokensPerMonth / 1e6) * api.output + (inputTokensPerMonth / 1e6) * api.input;
                const selfHost = cheapestSelfHostFor(api.selfHostModel);
                if (!selfHost) return null;
                const selfHostTCOPerAPI = selfHost.tco;
                const savings = apiMonthly - selfHostTCOPerAPI;
                const selfHostCheaper = savings > 0;
                const pctDiff = apiMonthly > 0 ? ((savings / apiMonthly) * 100) : 0;

                let breakEvenRPS = null;
                let belowMinScale = false;
                if (!selfHostCheaper) {
                  for (let r = targetRPS; r <= 5000; r += (r < 50 ? 5 : r < 200 ? 10 : 50)) {
                    const sh = cheapestSelfHostFor(api.selfHostModel, r);
                    if (!sh) continue;
                    const apiMo = (r * 3600 * activeHoursPerDay * 30 * avgOutputTokens / 1e6) * api.output + (r * 3600 * activeHoursPerDay * 30 * avgSeqLen / 1e6) * api.input;
                    if (sh.tco < apiMo) { breakEvenRPS = r; break; }
                  }
                } else {
                  for (let r = Math.max(1, Math.floor(targetRPS * 0.5)); r >= 1; r -= (r > 50 ? 10 : r > 10 ? 5 : 1)) {
                    const sh = cheapestSelfHostFor(api.selfHostModel, r);
                    if (!sh) continue;
                    const apiMo = (r * 3600 * activeHoursPerDay * 30 * avgOutputTokens / 1e6) * api.output + (r * 3600 * activeHoursPerDay * 30 * avgSeqLen / 1e6) * api.input;
                    if (sh.tco > apiMo) { breakEvenRPS = r + (r > 50 ? 10 : r > 10 ? 5 : 1); break; }
                  }
                  if (breakEvenRPS === null) belowMinScale = true;
                }
                return { ...api, apiMonthly, savings, selfHostCheaper, pctDiff, breakEvenRPS, belowMinScale, selfHostTCO: selfHostTCOPerAPI, selfHostInfo: selfHost };
              }).filter(Boolean).sort((a, b) => a.apiMonthly - b.apiMonthly);

              const cheapestAPI = apiComparisons[0];
              const bestSavings = apiComparisons.reduce((b, c) => c.savings > b.savings ? c : b, apiComparisons[0]);

              const verdictSelfHost = bestSavings.savings > 500;
              const verdictAPI = cheapestAPI && cheapestAPI.savings < 0;
              const verdictDepends = !verdictSelfHost && !verdictAPI;

              return (
                <div style={{ borderRadius: 10, border: `1px solid ${verdictSelfHost ? "rgba(110,231,183,0.2)" : verdictAPI ? "rgba(248,113,113,0.2)" : "rgba(251,191,36,0.2)"}`, background: verdictSelfHost ? "rgba(110,231,183,0.03)" : verdictAPI ? "rgba(248,113,113,0.03)" : "rgba(251,191,36,0.03)", padding: "16px 18px", marginBottom: 16 }}>
                  {/* Verdict header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, background: verdictSelfHost ? "rgba(110,231,183,0.1)" : verdictAPI ? "rgba(248,113,113,0.1)" : "rgba(251,191,36,0.1)" }}>
                      {verdictSelfHost ? "🖥" : verdictAPI ? "☁" : "⚖"}
                    </div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: F, color: verdictSelfHost ? "#6ee7b7" : verdictAPI ? "#f87171" : "#fbbf24" }}>
                        {verdictSelfHost ? "Self-host saves you money" : verdictAPI ? "Use the API instead" : "It depends on your priorities"}
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", fontFamily: F }}>
                        {verdictSelfHost ? `Up to $${bestSavings.savings.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo cheaper than ${bestSavings.name}` : verdictAPI ? `${cheapestAPI.name} is $${Math.abs(cheapestAPI.savings).toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo cheaper (incl. ops overhead)` : "Self-host is cheaper for raw compute, but factor in engineering time"}
                      </div>
                    </div>
                  </div>

                  {/* Side-by-side: self-host vs each API */}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                      <thead><tr>
                        <th style={{ padding: "6px 8px", textAlign: "left", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>API option</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>API $/mo</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>Self-host TCO/mo</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>Difference</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>Verdict</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>Breakeven</th>
                      </tr></thead>
                      <tbody>
                        {apiComparisons.map((c, i) => (
                          <tr key={c.name} style={{ background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", color: "#cbd5e1" }}>
                              {c.name}
                              <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 9, marginTop: 1 }}>
                                ${c.input}/${c.output} per 1M · vs self-host {MODEL_PRESETS[c.selfHostModel]?.name || c.selfHostModel}
                              </div>
                            </td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "rgba(255,255,255,0.5)" }}>
                              ${c.apiMonthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "rgba(255,255,255,0.5)" }}>
                              ${c.selfHostTCO.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 8, marginTop: 1 }}>
                                {c.selfHostInfo.gpus} × {c.selfHostInfo.instance.gpu.replace("_"," ")} on {c.selfHostInfo.instance.provider}
                              </div>
                            </td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: c.selfHostCheaper ? "#34d399" : "#f87171", fontWeight: 600 }}>
                              {c.selfHostCheaper ? "−" : "+"}${Math.abs(c.savings).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", fontWeight: 600 }}>
                              {c.selfHostCheaper ? (
                                <span style={{ color: "#6ee7b7" }}>Self-host {c.pctDiff > 0 ? `(${c.pctDiff.toFixed(0)}% less)` : ""}</span>
                              ) : (
                                <span style={{ color: "#f87171" }}>API cheaper</span>
                              )}
                            </td>
                            <td style={{ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", textAlign: "right", color: "rgba(255,255,255,0.4)", fontSize: 9 }}>
                              {c.belowMinScale ? <span title="Self-host wins even at 1 req/s — minimum GPU is so under-utilized that any traffic level beats this API">any scale</span>
                                : c.breakEvenRPS ? `${c.breakEvenRPS} req/s${c.selfHostCheaper ? " (min)" : ""}`
                                : "never"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Explanation */}
                  <div style={{ marginTop: 10, fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: F, lineHeight: 1.7 }}>
                    <span style={{ fontWeight: 600, color: "rgba(255,255,255,0.35)" }}>How to read this:</span> Each row compares an <span style={{ color: "rgba(255,255,255,0.4)" }}>API</span> against the cost to <span style={{ color: "rgba(255,255,255,0.4)" }}>self-host an open-source model of equivalent capability</span>.
                    For example, Claude Opus is compared to self-hosting Llama 3 405B; Mistral Small API to self-hosting Llama 3 8B. Each row's "Self-host TCO/mo" picks the cheapest cloud instance for that specific model at your traffic level ({targetRPS} req/s × {avgSeqLen} in + {avgOutputTokens} out).
                    {includeProviderCosts ? ` Includes ${opsOverheadPct}% ops overhead, egress, and provider extras.` : ` Includes a default 35% ops overhead.`}
                    "Breakeven" shows where the math flips with traffic changes.
                  </div>
                </div>
              );
            })()}

            {/* ── Decision notes ── */}
            <div style={{ background: "rgba(255,255,255,0.015)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.04)", fontSize: 11, fontFamily: F, color: "rgba(255,255,255,0.4)", lineHeight: 1.8, marginBottom: 16 }}>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Fleet sizing notes</div>
              {result.utilization_with_hours < 0.15 && <p style={{ color: "#fb923c" }}>Overall utilization is only {(result.utilization_with_hours * 100).toFixed(0)}% (including idle hours). You're paying for a lot of idle GPU time. {activeHoursPerDay < 24 ? `Consider spot instances or auto-scaling to shut down GPUs during the ${24 - activeHoursPerDay} off-peak hours.` : "Try reducing GPUs or increasing batch size."}</p>}
              {result.utilization_with_hours >= 0.15 && result.utilization < 0.3 && <p style={{ color: "#fb923c" }}>Average utilization is {(result.utilization * 100).toFixed(0)}% — fleet is over-provisioned for average traffic. This is {peakMultiplier > 1 ? `partly because you're provisioning for ${peakMultiplier}x peak bursts` : "because replicas can't be fractional"}. Consider autoscaling if your cloud supports it.</p>}
              {result.utilization_at_peak > 0.9 && <p style={{ color: "#f87171" }}>At peak traffic ({result.provisionRPS} req/s), utilization hits {(result.utilization_at_peak * 100).toFixed(0)}% — no headroom for unexpected spikes. Add {result.gpus_per_replica} more GPU(s) for safety.</p>}
              {result.utilization >= 0.3 && result.utilization_at_peak <= 0.9 && result.utilization_with_hours >= 0.15 && <p style={{ color: "#6ee7b7" }}>Fleet sizing looks healthy — {(result.utilization * 100).toFixed(0)}% avg utilization with {(result.burst_headroom_pct).toFixed(0)}% burst headroom.</p>}
              {!result.meetsLatencySLA && <p style={{ color: "#f87171" }}>Per-request latency ({(result.time_per_req * 1000).toFixed(0)}ms) exceeds your {latencyTargetMs >= 1000 ? (latencyTargetMs / 1000).toFixed(1) + "s" : latencyTargetMs + "ms"} SLA even at batch=1 — adding replicas cannot fix this (it reduces queueing, not service time). Reduce output length, use a smaller or more quantized model, or pick a faster GPU.</p>}
              {result.meetsLatencySLA && result.ttft_ms > 1000 && <p style={{ color: "#fbbf24" }}>Time to first token is {result.ttft_ms.toFixed(0)}ms — users will notice the delay. Consider prefill optimization, shorter context, or a faster GPU.</p>}
              {activeHoursPerDay < 24 && <p>You're running {activeHoursPerDay}h/day but paying for 24h — <span style={{ color: "#fbbf24" }}>${result.idle_cost_monthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo wasted on idle</span>. {activeHoursPerDay <= 12 ? "At this utilization, spot instances or serverless inference (e.g. Modal, Replicate) may be more cost-effective." : "Auto-shutdown scripts during off-hours can recover some of this."}</p>}
              {result.isBWbound && <p>Your workload is <span style={{ color: "#6ee7b7" }}>memory-bandwidth bound</span> — increasing batch size (currently {concurrentPerReplica}) will improve throughput without needing more GPUs.</p>}
              {!result.isBWbound && <p>Your workload is <span style={{ color: "#c084fc" }}>compute-bound</span> — you've saturated the GPU's compute. More throughput requires more replicas.</p>}
              {result.max_concurrent_per_replica < concurrentPerReplica && <p style={{ color: "#fb923c" }}>Warning: batch={concurrentPerReplica} but VRAM only fits {result.max_concurrent_per_replica} concurrent requests. KV cache for {concurrentPerReplica} reqs needs {fmt(result.kv_per_req_gb * concurrentPerReplica, 1)}GB but only {fmt(result.vram_for_kv, 1)}GB is free.</p>}
              <p style={{ color: "rgba(255,255,255,0.2)", marginTop: 4 }}>Methodology: roofline with 60% compute / 85% BW efficiency; decode bandwidth includes per-step KV-cache reads (weights + batch × KV(avg ctx)); KV sized on input+output tokens; MoE batched decode reads min(total, active×batch) expert weights; TP width searched over practical sizes (1/2/4/8/16/32) for lowest cost; auto-batch maximizes throughput subject to the latency SLA. TP all-reduce efficiency ~93%/doubling within NVLink, steep penalty across nodes. These are roofline UPPER BOUNDS — production engines (vLLM, TRT-LLM) typically achieve 50-80% of them depending on paged attention, chunked prefill, prefix caching, and speculative decoding. Cloud and API prices are static snapshots (Apr 2026); refresh before using for real decisions.</p>
            </div>

          </>) : <div style={{ padding: 40, textAlign: "center", color: "rgba(255,255,255,0.3)", fontFamily: F }}>{allOptions.length === 0 ? "No cloud instances can serve this workload — try a smaller model, more aggressive quantization, or relaxed latency SLA" : "Configuration error — try different parameters"}</div>}
        </div>
      </div>
    </div>
  );
}

return App;
})();

const SellerSideApp = (() => {

// ═════════════════════════════════════════════════════════════════════════════
// INFERENCE COST MODELER: SELLER-SIDE
// Perspective inversion of the buyer-side fleet sizer. You are a compute
// provider / aggregator. You hold GPU supply at some cost basis and must decide
// how to monetize it: rent raw GPU-hours, or serve open-model tokens at market
// API prices. This tool answers: revenue, COGS, gross margin, break-even
// utilization, and which model is most profitable to serve per GPU-hour.
// Physics engine: corrected v2 roofline (KV-aware decode, practical TP search,
// TP communication efficiency). All market prices are editable snapshots.
// ═════════════════════════════════════════════════════════════════════════════

// ─── GPU specs (dense tensor figures, v2-corrected) ─────────────────────────
const GPU_SPECS = {
  H100: { vram: 80, fp16_tflops: 989, int8_tops: 1979, mem_bw: 3350, tdp: 700 },
  H200: { vram: 141, fp16_tflops: 989, int8_tops: 1979, mem_bw: 4800, tdp: 700 },
  B200: { vram: 192, fp16_tflops: 2250, int8_tops: 4500, mem_bw: 8000, tdp: 1000 },
  A100_80: { vram: 80, fp16_tflops: 312, int8_tops: 624, mem_bw: 2039, tdp: 300 },
  L40S: { vram: 48, fp16_tflops: 181, int8_tops: 362, mem_bw: 864, tdp: 350 },
};

// Market rates for renting GPUs OUT (what buyers pay you), $/GPU/hr — editable snapshots
const GPU_MARKET_RATES = { H100: 2.15, H200: 2.65, B200: 4.90, A100_80: 1.25, L40S: 0.85 };

// Acquisition cost presets: what the supply costs YOU
const PURCHASE_PRICE = { H100: 27500, H200: 32000, B200: 40000, A100_80: 17000, L40S: 11000 };

// ─── Serveable open models & market token prices ($/1M in, $/1M out) ────────
// Market prices ≈ what serverless providers charge (DeepInfra/Together/Fireworks
// band, Apr 2026 snapshot). You compete at or below these.
const MODEL_PRESETS = {
  "8B":       { name: "Llama 3 8B",            params_b: 8.03, layers: 32, hidden: 4096, heads: 32, kv_heads: 8,  p_in: 0.04, p_out: 0.08 },
  "32B":      { name: "Qwen 2.5 32B",          params_b: 32.5, layers: 64, hidden: 5120, heads: 40, kv_heads: 8,  p_in: 0.12, p_out: 0.35 },
  "70B":      { name: "Llama 3 70B",           params_b: 70.6, layers: 80, hidden: 8192, heads: 64, kv_heads: 8,  p_in: 0.27, p_out: 0.85 },
  "123B":     { name: "Mistral Large 123B",    params_b: 123,  layers: 88, hidden: 12288, heads: 96, kv_heads: 8, p_in: 0.55, p_out: 1.60 },
  "405B":     { name: "Llama 3 405B",          params_b: 405,  layers: 126, hidden: 16384, heads: 128, kv_heads: 8, p_in: 1.20, p_out: 2.40 },
  "671B_MoE": { name: "DeepSeek V3 (671B MoE)", params_b: 671, layers: 61, hidden: 7168, heads: 128, kv_heads: 128, moe: true, active_params_b: 37, kv_bytes_override: 70_000, p_in: 0.25, p_out: 0.85 },
};

const QUANT_LEVELS = { FP16: { bits: 16, label: "FP16/BF16" }, FP8: { bits: 8, label: "FP8" }, INT4: { bits: 4, label: "INT4 (AWQ)" } };

// ─── v2 physics engine, inverted: given TP width, what does one replica yield? ──
// Returns per-replica request throughput and token mix for a workload profile.
function replicaPhysics(gpuKey, modelKey, quantKey, kvDtype, avgIn, avgOut, slaS, cachedFrac = 0, eff = 1) {
  const gpu = GPU_SPECS[gpuKey];
  const m = MODEL_PRESETS[modelKey];
  const quant = QUANT_LEVELS[quantKey];
  const bytes_per_param = quant.bits / 8;
  const effective_params = m.moe ? m.active_params_b : m.params_b;
  const weight_gb = m.params_b * bytes_per_param;
  const head_dim = m.hidden / m.heads;
  const kv_elem = kvDtype === "FP8" ? 1 : 2;
  const kv_tok = m.kv_bytes_override ? m.kv_bytes_override * (kv_elem / 2) : 2 * m.kv_heads * head_dim * kv_elem * m.layers;
  const max_ctx = avgIn + avgOut;
  const kv_req_gb = kv_tok * max_ctx / 1e9;
  const kv_step_gb = kv_tok * (avgIn + avgOut / 2) / 1e9;
  const raw_min = Math.ceil((weight_gb + 2) / (gpu.vram * 0.92));

  const evalTP = (tp) => {
    const vram_kv = gpu.vram * tp * 0.92 - weight_gb - 2;
    if (vram_kv < kv_req_gb) return null;
    const tpEff = tp <= 8 ? Math.pow(0.93, Math.log2(tp)) : Math.pow(0.93, 3) * Math.pow(0.55, Math.log2(tp / 8));
    const bw = gpu.mem_bw * tp * 0.85 * tpEff;
    const flops = (quant.bits <= 8 ? gpu.int8_tops : gpu.fp16_tflops) * tp * 0.6 * tpEff;
    const maxB = Math.max(Math.floor(vram_kv / kv_req_gb), 1);
    const wRead = (B) => m.moe ? Math.min(m.params_b, m.active_params_b * B) * bytes_per_param : weight_gb;
    const stepT = (B) => Math.max((wRead(B) + B * kv_step_gb) / bw, (B * 2 * effective_params * 1e9) / (flops * 1e12));
    const prefillTps = (flops * 1e12) / (2 * effective_params * 1e9);
    const reqT = (B) => (avgIn * (1 - cachedFrac)) / prefillTps + avgOut * stepT(B); // cached prefix skips prefill
    const cands = []; for (let B = 1; B <= Math.min(maxB, 512); B = B < 8 ? B + 1 : B * 2) cands.push(B);
    if (!cands.includes(maxB) && maxB <= 512) cands.push(maxB);
    let B = 1; for (const c of cands) if (reqT(c) <= slaS) B = c;
    const t = reqT(B);
    return { tp, batch: B, reqTime: t, rps: (B / t) * eff, maxB, infeasible: reqT(1) > slaS };
  };

  let sel = null;
  for (const tp of [1, 2, 4, 8, 16, 32]) {
    if (tp < raw_min) continue;
    const r = evalTP(tp);
    if (!r) continue;
    // Seller optimizes tokens per GPU-hour → rps per GPU
    const rpsPerGpu = r.rps / tp;
    if (!sel || rpsPerGpu > sel.rpsPerGpu * (1 + 1e-9)) sel = { ...r, rpsPerGpu };
  }
  return sel; // null if model doesn't fit
}

// ─── Fleet economics ─────────────────────────────────────────────────────────
const HRS_MO = 730;

function costComponents(gpuKey, custom) {
  const spec = GPU_SPECS[gpuKey];
  const capexHr = (PURCHASE_PRICE[gpuKey] * custom.serverOverhead * (1 - (custom.residualPct || 0) / 100)) / (custom.deprMonths * HRS_MO);
  const kw = (spec.tdp * 1.25) / 1000;
  const opexHr = kw * custom.pue * custom.kwhPrice + kw * custom.coloKwMo / HRS_MO;
  return { capexHr, opexHr };
}
function costBasisPerGpuHr(mode, gpuKey, custom) {
  if (mode === "own") { const c = costComponents(gpuKey, custom); return c.capexHr + c.opexHr; }
  return custom.leaseRate; // wholesale lease or cloud resale: direct input
}

// ─── Formatting ──────────────────────────────────────────────────────────────
const fmtUSD = (n, d) => { if (n == null || !isFinite(n)) return "—"; if (Math.abs(n) < 1 && n !== 0) return "$" + n.toFixed(d ?? 3); return "$" + n.toLocaleString(undefined, { maximumFractionDigits: d ?? 0 }); };
const fmtBig = (n) => { if (n == null || !isFinite(n)) return "—"; const a = Math.abs(n); if (a >= 1e12) return (n / 1e12).toFixed(1) + "T"; if (a >= 1e9) return (n / 1e9).toFixed(1) + "B"; if (a >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (a >= 1e3) return (n / 1e3).toFixed(1) + "K"; return n.toFixed(0); };
const fmtPct = (n, d = 0) => (n * 100).toFixed(d) + "%";

// ─── UI primitives (matching buyer-side visual language) ────────────────────
const F = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const S = "'IBM Plex Sans', system-ui, sans-serif";

function Metric({ label, value, sub, accent, warn }) {
  return (
    <div style={{ background: warn ? "rgba(248,113,113,0.06)" : "rgba(255,255,255,0.02)", border: `1px solid ${warn ? "rgba(248,113,113,0.15)" : "rgba(255,255,255,0.05)"}`, borderRadius: 8, padding: "10px 12px", flex: "1 1 150px", minWidth: 150 }}>
      <div style={{ fontSize: 10, color: warn ? "rgba(248,113,113,0.7)" : "rgba(255,255,255,0.35)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 2, fontFamily: F }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "#e2e8f0", fontFamily: F, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2, fontFamily: F }}>{sub}</div>}
    </div>
  );
}
function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>{children}</div>;
}
function Slider({ label, value, onChange, min, max, step = 1, fmtFn, hint }) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: "#67e8f9", height: 3 }} />
        <span style={{ fontSize: 13, color: "#67e8f9", fontFamily: F, fontWeight: 600, minWidth: 62, textAlign: "right" }}>{fmtFn ? fmtFn(value) : value}</span>
      </div>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}
function Select({ label, value, onChange, options, hint }) {
  return (
    <Field label={label}>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", padding: "7px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, color: "#e2e8f0", fontSize: 12, fontFamily: F, outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value} style={{ background: "#0b1118" }}>{o.label}</option>)}
      </select>
      {hint && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: F, marginTop: 2 }}>{hint}</div>}
    </Field>
  );
}
function Section({ title, children, style: s }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.015)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.04)", ...s }}>
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, fontFamily: F }}>{title}</div>
      {children}
    </div>
  );
}
const td = (extra = {}) => ({ padding: "5px 8px", borderBottom: "1px solid rgba(255,255,255,0.02)", ...extra });
const th = (align = "right") => ({ padding: "5px 8px", textAlign: align, color: "rgba(255,255,255,0.25)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 });

// ─── Main App ────────────────────────────────────────────────────────────────
function App() {
  // Supply
  const [gpuKey, setGpuKey] = useState("H200");
  const [fleetSize, setFleetSize] = useState(512);
  const [acqMode, setAcqMode] = useState("own");
  const [leaseRate, setLeaseRate] = useState(1.75);
  const [deprMonths, setDeprMonths] = useState(36);
  const [kwhPrice, setKwhPrice] = useState(0.08);
  const [coloKwMo, setColoKwMo] = useState(140);
  const [opsPct, setOpsPct] = useState(12);

  // Monetization mix
  const [pctTokens, setPctTokens] = useState(60); // % of fleet serving tokens vs raw rental
  const [rentalRate, setRentalRate] = useState(GPU_MARKET_RATES["H200"]);
  const [rentalUtil, setRentalUtil] = useState(70);   // % of rentable hours actually sold
  const [tokenUtil, setTokenUtil] = useState(55);     // % of token capacity actually sold

  // Token-serving config
  const [modelKey, setModelKey] = useState("671B_MoE");
  const [quantKey, setQuantKey] = useState("FP8");
  const [kvDtype, setKvDtype] = useState("FP8");
  const [avgIn, setAvgIn] = useState(2048);
  const [avgOut, setAvgOut] = useState(768);
  const [slaS, setSlaS] = useState(30);
  const [priceDiscount, setPriceDiscount] = useState(10); // % below market you price to win share
  const [cacheHit, setCacheHit] = useState(30);       // % of input tokens served from prefix cache
  const [elasticity, setElasticity] = useState(1.5);  // demand response: utilization multiplier per 1% price move
  const [tokDecline, setTokDecline] = useState(40);   // market token price decline %/yr
  const [rentDecline, setRentDecline] = useState(25); // GPU rental market decline %/yr
  const [servingEff, setServingEff] = useState(65);   // % of roofline achieved in production (multi-tenancy, scheduling)
  const [smPct, setSmPct] = useState(12);             // sales & marketing as % of revenue
  const [spotBurst, setSpotBurst] = useState("on");   // serve overflow demand on spot GPUs
  const [spotRate, setSpotRate] = useState(1.20);     // $/GPU/hr upstream spot price
  const [residualPct, setResidualPct] = useState(15); // hardware residual value at end of depreciation
  const [model2Key, setModel2Key] = useState("70B");  // portfolio: secondary model
  const [pct2, setPct2] = useState(0);                // % of token fleet on secondary model
  const CACHE_BILL = 0.10; // cached input tokens billed at 10% of input price (industry convention)
  const EGRESS_PER_GB = 0.05; // blended egress $/GB (colo bandwidth commit)

  const m = MODEL_PRESETS[modelKey];
  const custom = { serverOverhead: 1.35, deprMonths, pue: 1.2, kwhPrice, coloKwMo, leaseRate, residualPct };
  const costHr = useMemo(() => costBasisPerGpuHr(acqMode, gpuKey, custom), [acqMode, gpuKey, deprMonths, kwhPrice, coloKwMo, leaseRate, residualPct]);

  // Physics: what one replica of the chosen model yields on this GPU
  const phys = useMemo(() => replicaPhysics(gpuKey, modelKey, quantKey, kvDtype, avgIn, avgOut, slaS, cacheHit / 100, servingEff / 100),
    [gpuKey, modelKey, quantKey, kvDtype, avgIn, avgOut, slaS, cacheHit, servingEff]);
  const phys2 = useMemo(() => pct2 > 0 ? replicaPhysics(gpuKey, model2Key, quantKey, kvDtype, avgIn, avgOut, slaS, cacheHit / 100, servingEff / 100) : null,
    [gpuKey, model2Key, pct2, quantKey, kvDtype, avgIn, avgOut, slaS, cacheHit, servingEff]);

  // ── Token-side economics helper: given a discount and base utilization, compute
  // revenue and variable cost across the model portfolio, including elasticity and
  // spot-burst overflow (demand above 100% fill served on spot-rented GPUs).
  const tokenSide = (d, utilBase) => {
    const ch = cacheHit / 100;
    const tokenGpus = Math.floor(fleetSize * pctTokens / 100);
    const gpus2 = Math.floor(tokenGpus * pct2 / 100);
    const gpus1 = tokenGpus - gpus2;
    const uncapped = Math.max(utilBase * (1 + elasticity * (d / 100)), 2);
    const util = Math.min(uncapped, 100);
    const overflow = spotBurst === "on" ? Math.max(uncapped - 100, 0) : 0;
    let rev = 0, spotCost = 0, tokensIn = 0, tokensOut = 0, replicas = 0;
    const slots = [
      { p: phys, mp: m, g: gpus1 },
      ...(pct2 > 0 ? [{ p: phys2, mp: MODEL_PRESETS[model2Key], g: gpus2 }] : []),
    ];
    for (const s of slots) {
      if (!s.p || s.g < s.p.tp) continue;
      const reps = Math.floor(s.g / s.p.tp);
      replicas += reps;
      const fullReqs = reps * s.p.rps * 3600 * HRS_MO;
      const baseReqs = fullReqs * (util / 100);
      const overReqs = fullReqs * (overflow / 100);
      const pin = s.mp.p_in * (1 - d / 100) * ((1 - ch) + ch * CACHE_BILL);
      const pout = s.mp.p_out * (1 - d / 100);
      const revPerReq = (avgIn / 1e6) * pin + (avgOut / 1e6) * pout;
      rev += (baseReqs + overReqs) * revPerReq;
      tokensIn += (baseReqs + overReqs) * avgIn;
      tokensOut += (baseReqs + overReqs) * avgOut;
      // Spot GPUs rented only for the hours the overflow actually runs
      if (overReqs > 0) spotCost += (overReqs / (s.p.rps * 3600)) * s.p.tp * spotRate;
    }
    return { rev, spotCost, tokensIn, tokensOut, util, overflow, replicas, tokenGpus, gpus1, gpus2 };
  };

  // ── Fleet economics ──
  const econ = useMemo(() => {
    const t = tokenSide(priceDiscount, tokenUtil);
    const rentalGpus = fleetSize - t.tokenGpus;
    const rentalRevMo = rentalGpus * rentalRate * HRS_MO * (rentalUtil / 100);

    const fleetCostMo = fleetSize * costHr * HRS_MO * (1 + opsPct / 100);
    const egressCost = (t.tokensOut * 4) / 1e9 * EGRESS_PER_GB; // ~4 bytes per output token
    const totalCostMo = fleetCostMo + t.spotCost + egressCost;

    const revMo = rentalRevMo + t.rev;
    const gmMo = revMo - totalCostMo;
    const gmPct = revMo > 0 ? gmMo / revMo : -1;
    const smMo = revMo * (smPct / 100);          // sales & marketing / CAC
    const cmMo = gmMo - smMo;                     // contribution margin after S&M
    const cmPct = revMo > 0 ? cmMo / revMo : -1;

    // Break-even (base fleet, no overflow): fixed fleet cost vs revenue linear in fill
    const soldFrac = (t.util + t.overflow) / 100;
    const revAtFull = rentalGpus * rentalRate * HRS_MO + (soldFrac > 0 ? t.rev / soldFrac : 0);
    const breakEvenUtil = revAtFull > 0 ? fleetCostMo / revAtFull : null;

    // Token-side unit economics
    const costPerGpuHrLoaded = costHr * (1 + opsPct / 100);
    const tokenCostMo = t.tokenGpus * costPerGpuHrLoaded * HRS_MO + t.spotCost + egressCost;
    const blendedCostPer1M = (t.tokensIn + t.tokensOut) > 0 ? tokenCostMo / ((t.tokensIn + t.tokensOut) / 1e6) : null;
    const blendedRevPer1M = (t.tokensIn + t.tokensOut) > 0 ? t.rev / ((t.tokensIn + t.tokensOut) / 1e6) : null;
    const revPerGpuHrToken = t.tokenGpus > 0 ? t.rev / (t.tokenGpus * HRS_MO) : 0;

    return { tokenGpus: t.tokenGpus, rentalGpus, totalCostMo, fleetCostMo, spotCostMo: t.spotCost, egressCost, rentalRevMo, tokenRevMo: t.rev, revMo, gmMo, gmPct, smMo, cmMo, cmPct, breakEvenUtil, replicas: t.replicas, tokensInMo: t.tokensIn, tokensOutMo: t.tokensOut, effTokenUtil: t.util, overflowUtil: t.overflow, revPerGpuHrToken, costPerGpuHrLoaded, blendedCostPer1M, blendedRevPer1M };
  }, [fleetSize, pctTokens, pct2, model2Key, costHr, opsPct, rentalRate, rentalUtil, tokenUtil, phys, phys2, avgIn, avgOut, m, priceDiscount, cacheHit, elasticity, spotBurst, spotRate, smPct]);

  // ── Per-model serving league table: revenue per GPU-hr for every model ──
  const modelLeague = useMemo(() => {
    const ch = cacheHit / 100;
    return Object.entries(MODEL_PRESETS).map(([k, mp]) => {
      const p = replicaPhysics(gpuKey, k, quantKey, kvDtype, avgIn, avgOut, slaS, ch, servingEff / 100);
      if (!p) return { key: k, name: mp.name, fits: false };
      const reqsPerGpuHr = p.rpsPerGpu * 3600;
      const inBilled = mp.p_in * ((1 - ch) + ch * CACHE_BILL);
      const revPerGpuHr = reqsPerGpuHr * ((avgIn / 1e6) * inBilled + (avgOut / 1e6) * mp.p_out) * (1 - priceDiscount / 100);
      return { key: k, name: mp.name, fits: true, tp: p.tp, batch: p.batch, revPerGpuHr, tokPerGpuHr: reqsPerGpuHr * (avgIn + avgOut), infeasible: p.infeasible };
    }).sort((a, b) => (b.revPerGpuHr || -1) - (a.revPerGpuHr || -1));
  }, [gpuKey, quantKey, kvDtype, avgIn, avgOut, slaS, priceDiscount, cacheHit, servingEff]);

  // ── Utilization sensitivity: margin at each sold-utilization level ──
  const utilSweep = useMemo(() => {
    return [20, 30, 40, 50, 60, 70, 80, 90, 95].map(u => {
      const t = tokenSide(priceDiscount, u);
      const rentalRev = econ.rentalGpus * rentalRate * HRS_MO * (u / 100);
      const egress = (t.tokensOut * 4) / 1e9 * EGRESS_PER_GB;
      const rev = rentalRev + t.rev;
      const gm = rev - econ.fleetCostMo - t.spotCost - egress;
      return { u, rev, gm, gmPct: rev > 0 ? gm / rev : -1 };
    });
  }, [econ, rentalRate, phys, phys2, avgIn, avgOut, priceDiscount, cacheHit, elasticity, spotBurst, spotRate, pct2, model2Key, fleetSize, pctTokens, tokenUtil]);

  // ── Price optimization — where does elasticity say margin peaks? ──
  const priceSweep = useMemo(() => {
    const rows = [-20, -10, -5, 0, 5, 10, 15, 20, 30, 40, 50, 60].map(d => {
      const t = tokenSide(d, tokenUtil);
      const egress = (t.tokensOut * 4) / 1e9 * EGRESS_PER_GB;
      const rev = econ.rentalRevMo + t.rev;
      const gm = rev - econ.fleetCostMo - t.spotCost - egress;
      return { d, util: t.util, overflow: t.overflow, rev, gm, capped: t.util >= 100 && t.overflow === 0 };
    });
    const bestGm = Math.max(...rows.map(r => r.gm));
    return rows.map(r => ({ ...r, isOpt: Math.abs(r.gm - bestGm) < 1 }));
  }, [econ, phys, phys2, tokenUtil, elasticity, m, model2Key, pct2, avgIn, avgOut, cacheHit, spotBurst, spotRate, fleetSize, pctTokens]);

  // ── NEW: Hardware generation comparison — same monthly budget, different silicon ──
  const hwCompare = useMemo(() => {
    const budget = econ.totalCostMo;
    const ch = cacheHit / 100;
    const pinAdj = m.p_in * (1 - priceDiscount / 100) * ((1 - ch) + ch * CACHE_BILL);
    const poutAdj = m.p_out * (1 - priceDiscount / 100);
    return Object.keys(GPU_SPECS).map(g => {
      const cb = acqMode === "own"
        ? costBasisPerGpuHr("own", g, custom)
        : leaseRate * (GPU_MARKET_RATES[g] / GPU_MARKET_RATES[gpuKey]); // scale lease by market ratio
      const loaded = cb * (1 + opsPct / 100);
      const gpus = Math.floor(budget / (loaded * HRS_MO));
      const p = replicaPhysics(g, modelKey, quantKey, kvDtype, avgIn, avgOut, slaS, ch, servingEff / 100);
      const tokenG = Math.floor(gpus * pctTokens / 100), rentG = gpus - tokenG;
      const reps = p ? Math.floor(tokenG / p.tp) : 0;
      const reqsMo = reps * (p?.rps || 0) * 3600 * HRS_MO * (econ.effTokenUtil / 100);
      const tokRev = (reqsMo * avgIn / 1e6) * pinAdj + (reqsMo * avgOut / 1e6) * poutAdj;
      const rentRev = rentG * GPU_MARKET_RATES[g] * HRS_MO * (rentalUtil / 100);
      const rev = tokRev + rentRev;
      return { g, gpus, cb, rev, gm: rev - budget, fits: !!p, tokPerMo: reqsMo * (avgIn + avgOut) };
    }).sort((a, b) => b.gm - a.gm);
  }, [econ, acqMode, leaseRate, gpuKey, opsPct, modelKey, quantKey, kvDtype, avgIn, avgOut, slaS, pctTokens, rentalUtil, m, priceDiscount, cacheHit, deprMonths, kwhPrice, coloKwMo, servingEff, residualPct]);

  // ── Multi-year projection — market prices fall, your cost basis doesn't ──
  const multiYear = useMemo(() => {
    const comps = costComponents(gpuKey, custom);
    let cumCm = 0;
    return [1, 2, 3, 4].map(y => {
      const fTok = Math.pow(1 - tokDecline / 100, y - 1);
      const fRent = Math.pow(1 - rentDecline / 100, y - 1);
      // Owned hardware: capex burden expires with depreciation; after that, GPUs run on power+colo only
      const capFrac = acqMode === "own" ? Math.min(Math.max((deprMonths - (y - 1) * 12) / 12, 0), 1) : null;
      const costHrY = acqMode === "own" ? comps.capexHr * capFrac + comps.opexHr : leaseRate;
      const fleetYr = fleetSize * costHrY * HRS_MO * 12 * (1 + opsPct / 100);
      const tokRevYr = econ.tokenRevMo * 12 * fTok;               // token prices decline
      const spotYr = econ.spotCostMo * 12 * fRent;                // spot GPU prices decline with rental market
      const egressYr = econ.egressCost * 12;                      // flat
      const rentRevYr = econ.rentalRevMo * 12 * fRent;            // rental prices decline
      const rev = tokRevYr + rentRevYr;
      const cogsYr = fleetYr + spotYr + egressYr;
      const gm = rev - cogsYr;
      const sm = rev * (smPct / 100);
      const cm = gm - sm;
      cumCm += cm;
      return { y, fTok, fRent, costHrY, cogsYr, rev, gm, gmPct: rev > 0 ? gm / rev : -1, cm, cumCm };
    });
  }, [econ, gpuKey, acqMode, leaseRate, deprMonths, kwhPrice, coloKwMo, residualPct, opsPct, fleetSize, tokDecline, rentDecline, smPct]);

  const gmColor = econ.gmPct >= 0.4 ? "#6ee7b7" : econ.gmPct >= 0.15 ? "#fbbf24" : "#f87171";

  return (
    <div style={{ minHeight: "100vh", background: "#0b1118", color: "#e2e8f0", fontFamily: S }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input[type=range]{-webkit-appearance:none;background:rgba(255,255,255,0.06);border-radius:3px;height:4px}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#67e8f9;cursor:pointer;border:2px solid #0b1118}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:2px}
      `}</style>

      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", fontFamily: F, lineHeight: 1.5 }}>
          Model the P&L of a compute provider or aggregator holding GPU supply: turn a fleet's cost basis into sellable capacity and margin, weigh renting raw GPU-hours against serving tokens, and find where to price as market rates fall.
          <span style={{ display: "block", fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 3 }}>supply cost basis → sellable capacity → margin · demand elasticity · multi-year outlook · price snapshots Apr 2026</span>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap" }}>
        {/* ═══ LEFT: Supply & monetization config ═══ */}
        <div style={{ width: 290, padding: 16, borderRight: "1px solid rgba(255,255,255,0.04)", background: "rgba(255,255,255,0.005)", flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>Supply</div>
          <Select label="GPU" value={gpuKey} onChange={v => { setGpuKey(v); setRentalRate(GPU_MARKET_RATES[v]); setSpotRate(+(GPU_MARKET_RATES[v] * 0.45).toFixed(2)); }} options={Object.keys(GPU_SPECS).map(k => ({ value: k, label: k.replace("_", " ") }))} />
          <Slider label="Fleet size" value={fleetSize} onChange={setFleetSize} min={8} max={8192} step={8} fmtFn={v => v + " GPUs"} />
          <Select label="Cost basis" value={acqMode} onChange={setAcqMode} options={[
            { value: "own", label: "Own hardware + colo" },
            { value: "lease", label: "Wholesale lease ($/GPU/hr)" },
          ]} hint={acqMode === "own" ? `$${PURCHASE_PRICE[gpuKey].toLocaleString()}/GPU × 1.35 system overhead` : "Direct rate you pay upstream"} />
          {acqMode === "own" ? (<>
            <Slider label="Depreciation" value={deprMonths} onChange={setDeprMonths} min={24} max={60} step={6} fmtFn={v => v + " mo"} />
            <Slider label="Power price" value={kwhPrice} onChange={setKwhPrice} min={0.03} max={0.18} step={0.005} fmtFn={v => "$" + v.toFixed(3)} hint="$/kWh · PUE 1.2 applied" />
            <Slider label="Colo rate" value={coloKwMo} onChange={setColoKwMo} min={60} max={300} step={10} fmtFn={v => "$" + v + "/kW"} />
            <Slider label="Residual value" value={residualPct} onChange={setResidualPct} min={0} max={40} step={5} fmtFn={v => v + "%"} hint="Hardware worth at end of depreciation — reduces depreciable base" />
          </>) : (
            <Slider label="Lease rate" value={leaseRate} onChange={setLeaseRate} min={0.5} max={6} step={0.05} fmtFn={v => "$" + v.toFixed(2)} />
          )}
          <Slider label="Ops overhead" value={opsPct} onChange={setOpsPct} min={0} max={40} step={1} fmtFn={v => v + "%"} hint="SRE, support, billing infra on top of COGS" />

          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, margin: "16px 0 8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Monetization mix</div>
          <Slider label="Fleet serving tokens" value={pctTokens} onChange={setPctTokens} min={0} max={100} step={5} fmtFn={v => v + "%"} hint="Remainder rented as raw GPU-hours" />
          <Slider label="GPU rental price" value={rentalRate} onChange={setRentalRate} min={0.3} max={7} step={0.05} fmtFn={v => "$" + v.toFixed(2)} hint={`Market ~$${GPU_MARKET_RATES[gpuKey].toFixed(2)} for ${gpuKey.replace("_", " ")}`} />
          <Slider label="Rental utilization" value={rentalUtil} onChange={setRentalUtil} min={10} max={100} step={5} fmtFn={v => v + "%"} hint="% of rentable hours actually sold" />
          <Slider label="Token utilization" value={tokenUtil} onChange={setTokenUtil} min={10} max={100} step={5} fmtFn={v => v + "%"} hint="% of serving capacity actually sold" />

          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, margin: "16px 0 8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Token product</div>
          <Select label="Model served" value={modelKey} onChange={setModelKey} options={Object.entries(MODEL_PRESETS).map(([k, v]) => ({ value: k, label: v.name }))} hint={`Market price $${m.p_in}/$${m.p_out} per 1M in/out`} />
          <Slider label="Fleet on 2nd model" value={pct2} onChange={setPct2} min={0} max={50} step={5} fmtFn={v => v + "%"} hint="Portfolio serving: split token fleet across two models" />
          {pct2 > 0 && <Select label="Secondary model" value={model2Key} onChange={setModel2Key} options={Object.entries(MODEL_PRESETS).filter(([k]) => k !== modelKey).map(([k, v]) => ({ value: k, label: v.name }))} hint={`Market price $${MODEL_PRESETS[model2Key]?.p_in}/$${MODEL_PRESETS[model2Key]?.p_out} per 1M`} />}
          <Select label="Quantization" value={quantKey} onChange={setQuantKey} options={Object.entries(QUANT_LEVELS).map(([k, v]) => ({ value: k, label: v.label }))} />
          <Select label="KV cache dtype" value={kvDtype} onChange={setKvDtype} options={[{ value: "FP16", label: "FP16" }, { value: "FP8", label: "FP8 (2x capacity)" }]} />
          <Slider label="Avg input tokens" value={avgIn} onChange={setAvgIn} min={128} max={32768} step={128} fmtFn={v => fmtBig(v)} />
          <Slider label="Avg output tokens" value={avgOut} onChange={setAvgOut} min={64} max={8192} step={64} fmtFn={v => fmtBig(v)} />
          <Slider label="Latency SLA" value={slaS} onChange={setSlaS} min={2} max={120} step={1} fmtFn={v => v + "s"} hint="Per-request budget you promise customers" />
          <Slider label="Prefix cache hit" value={cacheHit} onChange={setCacheHit} min={0} max={90} step={5} fmtFn={v => v + "%"} hint="Cached input skips prefill (more capacity) but bills at 10% of input price" />
          <Slider label="Price vs market" value={priceDiscount} onChange={setPriceDiscount} min={-20} max={60} step={5} fmtFn={v => v === 0 ? "at market" : (v > 0 ? "-" : "+") + Math.abs(v) + "%"} hint="Discount to win share (negative = premium)" />

          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)", fontFamily: F, margin: "16px 0 8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Market dynamics</div>
          <Slider label="Serving efficiency" value={servingEff} onChange={setServingEff} min={40} max={100} step={5} fmtFn={v => v + "%"} hint="Realized % of roofline: multi-tenancy, scheduling gaps, mixed batching (vLLM ~50-80%)" />
          <Slider label="Demand elasticity" value={elasticity} onChange={setElasticity} min={0} max={4} step={0.25} fmtFn={v => v.toFixed(2) + "x"} hint="Utilization response to price: at 1.5x, a 10% discount lifts fill 15%" />
          <Select label="Burst overflow" value={spotBurst} onChange={setSpotBurst} options={[{ value: "on", label: "Serve on spot GPUs" }, { value: "off", label: "Turn demand away" }]} hint="Demand above 100% fill: rent spot upstream or forfeit it" />
          {spotBurst === "on" && <Slider label="Spot rate (upstream)" value={spotRate} onChange={setSpotRate} min={0.2} max={5} step={0.05} fmtFn={v => "$" + v.toFixed(2)} hint={`What YOU pay for burst supply · ~45% of on-demand market`} />}
          <Slider label="S&M / CAC" value={smPct} onChange={setSmPct} min={0} max={40} step={1} fmtFn={v => v + "%"} hint="Sales & marketing as % of revenue — gross margin → contribution margin" />
          <Slider label="Token price decline" value={tokDecline} onChange={setTokDecline} min={0} max={70} step={5} fmtFn={v => v + "%/yr"} hint="Open-model API prices have fallen 30-60%/yr" />
          <Slider label="Rental price decline" value={rentDecline} onChange={setRentDecline} min={0} max={50} step={5} fmtFn={v => v + "%/yr"} hint="GPU-hr market rates as new silicon ships" />
        </div>

        {/* ═══ RIGHT: P&L ═══ */}
        <div style={{ flex: 1, padding: "16px 20px", minWidth: 0 }}>
          {/* Verdict banner */}
          <div style={{ background: `rgba(${econ.gmPct >= 0.15 ? "110,231,183" : "248,113,113"},0.04)`, border: `1px solid rgba(${econ.gmPct >= 0.15 ? "110,231,183" : "248,113,113"},0.12)`, borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: F, textTransform: "uppercase", letterSpacing: "0.08em" }}>Monthly gross margin</div>
                <div style={{ fontSize: 36, fontWeight: 700, color: gmColor, fontFamily: F, lineHeight: 1 }}>{econ.gmMo >= 0 ? "" : "−"}${fmtBig(Math.abs(econ.gmMo))} <span style={{ fontSize: 16, fontWeight: 500, color: "rgba(255,255,255,0.4)" }}>({fmtPct(econ.gmPct)})</span></div>
                <div style={{ fontSize: 11, color: econ.cmMo >= 0 ? "rgba(110,231,183,0.7)" : "#f87171", fontFamily: F, marginTop: 4 }}>contribution after {smPct}% S&M: {econ.cmMo >= 0 ? "" : "−"}${fmtBig(Math.abs(econ.cmMo))} ({fmtPct(econ.cmPct)})</div>
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", fontFamily: F, lineHeight: 1.7 }}>
                {fleetSize} × {gpuKey.replace("_", " ")} · cost basis <span style={{ color: "#fbbf24" }}>${costHr.toFixed(2)}/GPU/hr</span> (+{opsPct}% ops) · {servingEff}% serving efficiency
                <br />{econ.tokenGpus} GPUs serving <span style={{ color: "#67e8f9" }}>{m.name}</span>{pct2 > 0 ? <> + <span style={{ color: "#c4b5fd" }}>{MODEL_PRESETS[model2Key]?.name}</span> ({pct2}%)</> : null} ({econ.replicas} replicas) · {econ.rentalGpus} GPUs rented raw
                <br /><span style={{ color: "rgba(255,255,255,0.25)" }}>Effective token fill {econ.effTokenUtil.toFixed(0)}%{econ.overflowUtil > 0 ? ` + ${econ.overflowUtil.toFixed(0)}% overflow on spot` : ""} ({tokenUtil}% base{priceDiscount !== 0 ? `, elasticity from ${Math.abs(priceDiscount)}% ${priceDiscount > 0 ? "discount" : "premium"}` : ""}) · break-even at {econ.breakEvenUtil ? fmtPct(econ.breakEvenUtil) : "—"} blended {econ.breakEvenUtil > 1 ? "— unreachable at these prices" : ""}</span>
              </div>
            </div>
            {phys?.infeasible && <div style={{ marginTop: 8, fontSize: 10, fontFamily: F, color: "#f87171" }}>SLA {slaS}s is infeasible for {m.name} on {gpuKey.replace("_", " ")} even at batch=1 — relax the SLA or change hardware.</div>}
            {!phys && <div style={{ marginTop: 8, fontSize: 10, fontFamily: F, color: "#f87171" }}>{m.name} does not fit on {gpuKey.replace("_", " ")} at any practical TP width with this quantization.</div>}
          </div>

          {/* Key numbers */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            <Metric label="Revenue / mo" value={"$" + fmtBig(econ.revMo)} accent="#6ee7b7" sub={`tokens $${fmtBig(econ.tokenRevMo)} · rental $${fmtBig(econ.rentalRevMo)}`} />
            <Metric label="COGS / mo" value={"$" + fmtBig(econ.totalCostMo)} accent="#f87171" sub={`fleet $${fmtBig(econ.fleetCostMo)}${econ.spotCostMo > 0 ? ` · spot $${fmtBig(econ.spotCostMo)}` : ""} · egress $${fmtBig(econ.egressCost)}`} />
            <Metric label="Contribution / mo" value={(econ.cmMo >= 0 ? "$" : "−$") + fmtBig(Math.abs(econ.cmMo))} accent={econ.cmMo >= 0 ? "#6ee7b7" : "#f87171"} sub={`after $${fmtBig(econ.smMo)} S&M (${smPct}% of rev)`} warn={econ.cmMo < 0 && econ.gmMo >= 0} />
            <Metric label="Token rev / GPU-hr" value={fmtUSD(econ.revPerGpuHrToken, 2)} accent="#67e8f9" sub={`vs raw rental $${(rentalRate * rentalUtil / 100).toFixed(2)} (util-adj)`} warn={econ.revPerGpuHrToken > 0 && econ.revPerGpuHrToken < rentalRate * rentalUtil / 100} />
            <Metric label="Tokens sold / mo" value={fmtBig(econ.tokensInMo + econ.tokensOutMo)} sub={`${fmtBig(econ.tokensInMo)} in · ${fmtBig(econ.tokensOutMo)} out`} />
            <Metric label="Cost / 1M tok (blended)" value={econ.blendedCostPer1M != null ? fmtUSD(econ.blendedCostPer1M, 3) : "—"} accent="#fbbf24" sub={`sell @ ${econ.blendedRevPer1M != null ? fmtUSD(econ.blendedRevPer1M, 3) : "—"} blended`} warn={econ.blendedCostPer1M != null && econ.blendedRevPer1M != null && econ.blendedCostPer1M > econ.blendedRevPer1M} />
          </div>

          {/* ── NEW: Price optimization under elasticity ── */}
          <Section title={`Where should you price? Margin vs discount at ${elasticity.toFixed(2)}x demand elasticity`} style={{ marginBottom: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                <thead><tr><th style={th("left")}>Price vs market</th><th style={th()}>Implied fill</th><th style={th()}>Revenue/mo</th><th style={th()}>Gross margin/mo</th><th style={th("left")}> </th></tr></thead>
                <tbody>
                  {priceSweep.map((r, i) => {
                    const cur = r.d === priceDiscount;
                    return (
                      <tr key={r.d} style={{ background: r.isOpt ? "rgba(110,231,183,0.06)" : cur ? "rgba(103,232,249,0.05)" : i % 2 ? "rgba(255,255,255,0.008)" : "transparent" }}>
                        <td style={td({ color: r.isOpt ? "#6ee7b7" : cur ? "#67e8f9" : "#cbd5e1", fontWeight: r.isOpt || cur ? 600 : 400 })}>
                          {r.d === 0 ? "at market" : (r.d > 0 ? "-" : "+") + Math.abs(r.d) + "%"}
                          {r.isOpt && <span style={{ fontSize: 7, color: "rgba(110,231,183,0.6)", marginLeft: 4 }}>optimal</span>}
                          {cur && !r.isOpt && <span style={{ fontSize: 7, color: "rgba(103,232,249,0.5)", marginLeft: 4 }}>current</span>}
                        </td>
                        <td style={td({ textAlign: "right", color: r.overflow > 0 ? "#c4b5fd" : r.capped ? "#fbbf24" : "rgba(255,255,255,0.5)" })}>{r.util.toFixed(0)}%{r.overflow > 0 ? ` +${r.overflow.toFixed(0)}% spot` : r.capped ? " (capped)" : ""}</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>${fmtBig(r.rev)}</td>
                        <td style={td({ textAlign: "right", color: r.gm >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 600 })}>{r.gm >= 0 ? "" : "−"}${fmtBig(Math.abs(r.gm))}</td>
                        <td style={td()}><div style={{ height: 5, borderRadius: 2.5, background: "rgba(255,255,255,0.04)", minWidth: 70 }}><div style={{ width: `${Math.min(Math.max((r.gm / Math.max(...priceSweep.map(x => Math.abs(x.gm)), 1)) * 100, -100), 100) >= 0 ? Math.min((r.gm / Math.max(...priceSweep.map(x => x.gm), 1)) * 100, 100) : 4}%`, height: "100%", borderRadius: 2.5, background: r.gm >= 0 ? "#6ee7b7" : "#f87171", opacity: 0.7 }} /></div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6 }}>
              Discounting trades price for fill: at {elasticity.toFixed(2)}x elasticity, each 1% off market lifts sold utilization {elasticity.toFixed(2)}% relatively. {spotBurst === "on" ? `Demand beyond 100% fill is served on spot GPUs at $${spotRate.toFixed(2)}/hr — so deep discounts keep earning as long as spot-served tokens clear their marginal cost.` : "Demand beyond 100% fill is turned away — once capacity is full, further discounting only destroys margin."} Elasticity is the assumption to pressure-test with sales data.
            </div>
          </Section>

          {/* Model league table */}
          <Section title={`Which model earns the most per GPU-hour on ${gpuKey.replace("_", " ")}? (at ${priceDiscount > 0 ? priceDiscount + "% below" : priceDiscount < 0 ? Math.abs(priceDiscount) + "% above" : ""} market, ${tokenUtil}% util not applied — full-capacity rates)`} style={{ marginBottom: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                <thead><tr>
                  <th style={th("left")}>Model</th><th style={th()}>Market $/1M (in/out)</th><th style={th()}>TP</th><th style={th()}>Batch</th><th style={th()}>Tokens/GPU-hr</th><th style={th()}>Revenue/GPU-hr</th><th style={th()}>vs raw rental</th>
                </tr></thead>
                <tbody>
                  {modelLeague.map((r, i) => {
                    const vsRental = r.revPerGpuHr != null ? r.revPerGpuHr / rentalRate - 1 : null;
                    return (
                      <tr key={r.key} style={{ background: r.key === modelKey ? "rgba(103,232,249,0.05)" : i % 2 ? "rgba(255,255,255,0.008)" : "transparent" }}>
                        <td style={td({ color: r.key === modelKey ? "#67e8f9" : "#cbd5e1", fontWeight: r.key === modelKey ? 600 : 400 })}>{r.name}{r.key === modelKey && <span style={{ fontSize: 7, color: "rgba(103,232,249,0.5)", marginLeft: 4 }}>serving</span>}</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.4)" })}>${MODEL_PRESETS[r.key].p_in} / ${MODEL_PRESETS[r.key].p_out}</td>
                        {r.fits ? (<>
                          <td style={td({ textAlign: "right", color: "#c4b5fd" })}>{r.tp}</td>
                          <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.4)" })}>{r.batch}</td>
                          <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>{fmtBig(r.tokPerGpuHr)}</td>
                          <td style={td({ textAlign: "right", color: "#6ee7b7", fontWeight: 600 })}>${r.revPerGpuHr.toFixed(2)}</td>
                          <td style={td({ textAlign: "right", color: vsRental >= 0 ? "#6ee7b7" : "#f87171" })}>{vsRental >= 0 ? "+" : ""}{(vsRental * 100).toFixed(0)}%</td>
                        </>) : <td colSpan={5} style={td({ color: "rgba(248,113,113,0.5)" })}>doesn't fit on this GPU</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6 }}>
              The aggregator's core question: token-serving revenue per GPU-hour at full capacity vs. renting the GPU raw at ${rentalRate.toFixed(2)}/hr. Anything above +0% earns more serving tokens — IF you can fill the capacity. Workload mix: {avgIn} in / {avgOut} out, {slaS}s SLA.
            </div>
          </Section>

          {/* ── NEW: Hardware generation comparison — same budget, different silicon ── */}
          <Section title={`Same $${fmtBig(econ.totalCostMo)}/mo budget on different silicon — is ${gpuKey.replace("_", " ")} the right fleet?`} style={{ marginBottom: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                <thead><tr>
                  <th style={th("left")}>GPU</th><th style={th()}>Cost basis $/hr</th><th style={th()}>Fleet affordable</th><th style={th()}>Tokens sold/mo</th><th style={th()}>Revenue/mo</th><th style={th()}>Gross margin/mo</th><th style={th()}>vs current</th>
                </tr></thead>
                <tbody>
                  {hwCompare.map((r, i) => {
                    const cur = r.g === gpuKey;
                    const curRow = hwCompare.find(x => x.g === gpuKey);
                    const delta = curRow ? r.gm - curRow.gm : 0;
                    return (
                      <tr key={r.g} style={{ background: cur ? "rgba(103,232,249,0.05)" : i % 2 ? "rgba(255,255,255,0.008)" : "transparent" }}>
                        <td style={td({ color: cur ? "#67e8f9" : "#cbd5e1", fontWeight: cur || i === 0 ? 600 : 400 })}>{r.g.replace("_", " ")}{cur && <span style={{ fontSize: 7, color: "rgba(103,232,249,0.5)", marginLeft: 4 }}>current</span>}{i === 0 && !cur && <span style={{ fontSize: 7, color: "rgba(110,231,183,0.6)", marginLeft: 4 }}>best</span>}</td>
                        <td style={td({ textAlign: "right", color: "#fbbf24" })}>${r.cb.toFixed(2)}</td>
                        <td style={td({ textAlign: "right", color: "#c4b5fd" })}>{r.gpus.toLocaleString()}</td>
                        {r.fits ? (<>
                          <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>{fmtBig(r.tokPerMo)}</td>
                          <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>${fmtBig(r.rev)}</td>
                          <td style={td({ textAlign: "right", color: r.gm >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 600 })}>{r.gm >= 0 ? "" : "−"}${fmtBig(Math.abs(r.gm))}</td>
                          <td style={td({ textAlign: "right", color: cur ? "rgba(255,255,255,0.25)" : delta >= 0 ? "#6ee7b7" : "#f87171" })}>{cur ? "—" : (delta >= 0 ? "+" : "−") + "$" + fmtBig(Math.abs(delta))}</td>
                        </>) : <td colSpan={4} style={td({ color: "rgba(248,113,113,0.5)" })}>{m.name} doesn't fit on this GPU</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6 }}>
              Holds monthly COGS constant and asks what each generation's fleet earns serving the same product mix ({pctTokens}% tokens: {m.name}, {100 - pctTokens}% rented at that GPU's market rate). {acqMode === "own" ? "Cost basis from purchase price, power, and colo per GPU." : "Lease rates scaled by market-rate ratio to your current rate."} Newer silicon costs more per hour but serves more tokens per hour — this table shows which effect wins for YOUR workload.
            </div>
          </Section>

          {/* Utilization sensitivity */}
          <Section title="Margin vs sold utilization — the number that decides everything" style={{ marginBottom: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                <thead><tr><th style={th("left")}>Utilization</th><th style={th()}>Revenue/mo</th><th style={th()}>Gross margin/mo</th><th style={th()}>Margin %</th><th style={th("left")}> </th></tr></thead>
                <tbody>
                  {utilSweep.map((r, i) => {
                    const cur = Math.abs(r.u - (pctTokens > 50 ? tokenUtil : rentalUtil)) < 5;
                    const w = Math.min(Math.max((r.gmPct + 0.5) / 1.2, 0), 1);
                    return (
                      <tr key={r.u} style={{ background: cur ? "rgba(103,232,249,0.05)" : i % 2 ? "rgba(255,255,255,0.008)" : "transparent" }}>
                        <td style={td({ color: cur ? "#67e8f9" : "#cbd5e1", fontWeight: cur ? 600 : 400 })}>{r.u}%{cur && <span style={{ fontSize: 7, color: "rgba(103,232,249,0.5)", marginLeft: 4 }}>≈current</span>}</td>
                        <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>${fmtBig(r.rev)}</td>
                        <td style={td({ textAlign: "right", color: r.gm >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 600 })}>{r.gm >= 0 ? "" : "−"}${fmtBig(Math.abs(r.gm))}</td>
                        <td style={td({ textAlign: "right", color: r.gmPct >= 0.4 ? "#6ee7b7" : r.gmPct >= 0.15 ? "#fbbf24" : "#f87171" })}>{r.rev > 0 ? fmtPct(r.gmPct) : "—"}</td>
                        <td style={td()}><div style={{ height: 5, borderRadius: 2.5, background: "rgba(255,255,255,0.04)", minWidth: 80 }}><div style={{ width: `${w * 100}%`, height: "100%", borderRadius: 2.5, background: r.gm >= 0 ? "#6ee7b7" : "#f87171", opacity: 0.7 }} /></div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6 }}>
              Both rental and token utilization scaled together. Fleet COGS is fixed — you pay ${fmtBig(econ.fleetCostMo)}/mo whether GPUs are sold or idle (spot burst and egress scale with volume). Break-even: {econ.breakEvenUtil ? fmtPct(econ.breakEvenUtil) : "—"}. This is why commitment decisions hinge on demand confidence, not hardware specs.
            </div>
          </Section>

          {/* ── NEW: Multi-year projection — the scariest table in this business ── */}
          <Section title={`4-year projection: market prices fall ${tokDecline}%/yr (tokens) and ${rentDecline}%/yr (rental) — your cost basis doesn't`} style={{ marginBottom: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: F }}>
                <thead><tr>
                  <th style={th("left")}>Year</th><th style={th()}>Token price index</th><th style={th()}>Your cost $/GPU/hr</th><th style={th()}>Revenue/yr</th><th style={th()}>COGS/yr</th><th style={th()}>Gross margin/yr</th><th style={th()}>Margin %</th><th style={th()}>Contribution/yr</th><th style={th()}>Cumulative CM</th>
                </tr></thead>
                <tbody>
                  {multiYear.map((r, i) => (
                    <tr key={r.y} style={{ background: i % 2 ? "rgba(255,255,255,0.008)" : "transparent" }}>
                      <td style={td({ color: "#cbd5e1", fontWeight: 600 })}>Y{r.y}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.4)" })}>{(r.fTok * 100).toFixed(0)}%</td>
                      <td style={td({ textAlign: "right", color: "#fbbf24" })}>${r.costHrY.toFixed(2)}{acqMode === "own" && r.costHrY < costHr * 0.99 && <span style={{ fontSize: 7, color: "rgba(110,231,183,0.6)", marginLeft: 3 }}>depr done</span>}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.5)" })}>${fmtBig(r.rev)}</td>
                      <td style={td({ textAlign: "right", color: "rgba(255,255,255,0.4)" })}>${fmtBig(r.cogsYr)}</td>
                      <td style={td({ textAlign: "right", color: r.gm >= 0 ? "#6ee7b7" : "#f87171", fontWeight: 600 })}>{r.gm >= 0 ? "" : "−"}${fmtBig(Math.abs(r.gm))}</td>
                      <td style={td({ textAlign: "right", color: r.gmPct >= 0.4 ? "#6ee7b7" : r.gmPct >= 0.15 ? "#fbbf24" : "#f87171" })}>{r.rev > 0 ? fmtPct(r.gmPct) : "—"}</td>
                      <td style={td({ textAlign: "right", color: r.cm >= 0 ? "rgba(110,231,183,0.8)" : "#f87171" })}>{r.cm >= 0 ? "" : "−"}${fmtBig(Math.abs(r.cm))}</td>
                      <td style={td({ textAlign: "right", color: r.cumCm >= 0 ? "#6ee7b7" : "#f87171" })}>{r.cumCm >= 0 ? "" : "−"}${fmtBig(Math.abs(r.cumCm))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.15)", fontFamily: F, marginTop: 6, lineHeight: 1.6 }}>
              Volume held constant (conservative — falling prices usually grow demand; raise elasticity thinking here). {acqMode === "own"
                ? `Owned hardware has a second act: after ${deprMonths}-month depreciation, cost basis drops to power+colo only ($${(costComponents(gpuKey, custom).opexHr).toFixed(2)}/hr) — old GPUs serving budget models can stay profitable long after market prices collapse. The strategic question is whether Y3-Y4 market prices still clear your opex.`
                : "Leased supply has no second act: your rate is fixed while market prices fall — the term-length decision IS the margin decision. Shorter terms cost more per hour but let you reprice down with the market."} This table is why multi-year commitments hinge on price-decline assumptions more than on hardware specs.
            </div>
          </Section>

          {/* Assumptions */}
          <div style={{ background: "rgba(255,255,255,0.015)", borderRadius: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.04)", fontSize: 10, fontFamily: F, color: "rgba(255,255,255,0.3)", lineHeight: 1.8 }}>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Methodology & caveats</div>
            Physics: KV-aware roofline (60% compute / 85% BW efficiency, TP all-reduce ~93%/doubling in-node, batch auto-selected within SLA), haircut by the serving-efficiency slider to reflect production reality (multi-tenancy, scheduling gaps, mixed batching). Prefix-cache hits skip prefill and bill at 10% of input price; KV for shared prefixes is conservatively not deduplicated. Demand elasticity is linear; overflow beyond 100% fill is served on spot supply (if enabled) at your upstream spot rate. Egress ≈ 4 bytes/output token at ${EGRESS_PER_GB.toFixed(2)}/GB — computed to show it's negligible, not assumed away. S&M/CAC as % of revenue converts gross margin to contribution margin. Residual value reduces the depreciable base. Market token prices, GPU rates, and purchase prices are Apr 2026 snapshots — still the single biggest sensitivity. Not modeled: demand curves per model in the portfolio (allocation is manual, guided by the league table), financing costs / cost of capital, and multi-region supply.
          </div>
        </div>
      </div>
    </div>
  );
}

return App;
})();

const TAB_F = "'IBM Plex Mono', 'JetBrains Mono', monospace";

export default function App() {
  const [side, setSide] = useState("buyer");
  const tabs = [
    { key: "buyer", label: "BUYER-SIDE", sub: "fleet sizing & self-host vs API" },
    { key: "seller", label: "SELLER-SIDE", sub: "provider / aggregator P&L" },
  ];
  return (
    <div style={{ minHeight: "100vh", background: "#0b1118" }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 0, borderBottom: "1px solid rgba(255,255,255,0.07)", background: "#0b1118", padding: "0 20px", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", paddingRight: 20, borderRight: "1px solid rgba(255,255,255,0.05)", margin: "10px 0" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", fontFamily: TAB_F, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>Inference Cost Modeler</span>
        </div>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setSide(t.key)} style={{
            background: "none", border: "none", cursor: "pointer", padding: "12px 18px 10px",
            borderBottom: side === t.key ? "2px solid #67e8f9" : "2px solid transparent",
            display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", fontFamily: TAB_F, color: side === t.key ? "#67e8f9" : "rgba(255,255,255,0.35)" }}>{t.label}</span>
            <span style={{ fontSize: 9, fontFamily: TAB_F, color: side === t.key ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.18)" }}>{t.sub}</span>
          </button>
        ))}
      </div>
      <div style={{ display: side === "buyer" ? "block" : "none" }}><BuyerSideApp /></div>
      <div style={{ display: side === "seller" ? "block" : "none" }}><SellerSideApp /></div>
    </div>
  );
}
