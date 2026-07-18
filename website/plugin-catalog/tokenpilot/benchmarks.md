# TokenPilot Benchmarks

TokenPilot is evaluated on two benchmarks: **PinchBench** and **Claw-Eval**. Both measure agent task success and token efficiency.

<script setup>
</script>

## Evaluation Setup

| Parameter | Value |
| :-- | :-- |
| **Model** | GPT-5.4-mini (OpenClaw) |
| **Pricing** | $1.10/M input, $4.40/M cached input, $8.80/M output |
| **Modes** | Isolated (fresh session per task) and Continuous (shared session) |
| **TokenPilot mode** | Normal |

### Isolated vs. Continuous

- **Isolated**: Each task runs in a fresh session. No cross-task context accumulation. Tests single-task behavior.
- **Continuous**: Tasks run in a shared session. Context accumulates across tasks. Tests TokenPilot's ability to manage growing context.

TokenPilot's benefits are most visible in **continuous mode**, where context accumulation and cache reuse matter most.

## PinchBench

PinchBench measures performance across 11 task categories: Productivity, Research, Writing, Coding, Analysis, CSV Analysis, Log Analysis, Meeting Analysis, Memory, Skills, and Integrations.

[PinchBench results and logs](https://drive.google.com/drive/u/0/folders/11hrLzrreLnBFLz5bttx11lGUcO39QkLc)

### Continuous Mode (where TokenPilot excels)

| Method | Overall Score | Cache Read (M) | Cache Miss (M) | Output (M) | Cost ($) |
| :-- | --: | --: | --: | --: | --: |
| Vanilla | 79.2 | 25.015 | 5.943 | 0.202 | 7.24 |
| LLMLingua-2 | 73.8 | 20.574 | 2.183 | 0.194 | 4.06 |
| SelectiveContext | 74.0 | 25.475 | 2.608 | 0.196 | 4.75 |
| LCM | 77.0 | 18.708 | 2.417 | 0.222 | 4.21 |
| Keep-Last-N | 79.1 | 18.117 | 4.481 | 0.209 | 5.66 |
| MemOS | 80.9 | 30.859 | 8.939 | 0.308 | 10.41 |
| **TokenPilot** | **81.3** | **8.551** | **1.549** | **0.219** | **2.79** |

TokenPilot achieves:
- **67.4% fewer input tokens** vs. Vanilla (cache miss: 1.549M vs. 5.943M)
- **61.5% lower cost** vs. Vanilla ($2.79 vs. $7.24)
- **Best overall score** (81.3)
- **Lowest cache miss** and best cache reuse

### Isolated Mode

| Method | Overall Score | Cache Read (M) | Cache Miss (M) | Output (M) | Cost ($) |
| :-- | --: | --: | --: | --: | --: |
| Vanilla | 80.5 | 6.184 | 8.753 | 0.285 | 8.31 |
| MemoBrain | 78.1 | 10.200 | 2.107 | 0.233 | 3.36 |
| **TokenPilot** | **81.0** | **8.893** | **1.933** | **0.244** | **3.22** |

Even in isolated mode, TokenPilot achieves the best overall score and lowest cost.

## Claw-Eval

Claw-Eval measures performance across 12 task categories: Workflow, Operations, Finance, Office QA, Communication, Productivity, Operations, Safety, Terminal, Multimodal, and Others.

[Claw-Eval results and logs](https://drive.google.com/drive/u/0/folders/1694iNhrAzc8JtWTiUUALXsopZ8s6suCS)

### Continuous Mode

| Method | Overall Score | Cache Read (M) | Cache Miss (M) | Output (M) | Cost ($) |
| :-- | --: | --: | --: | --: | --: |
| Vanilla | **63.4** | 709.845 | 21.981 | 2.622 | 81.52 |
| MemoBrain | 57.9 | 47.497 | 13.990 | 1.134 | 19.16 |
| AgentSwing | 62.2 | 53.776 | 10.027 | 0.907 | 15.63 |
| **TokenPilot** | **60.8** | **21.430** | **9.928** | **0.338** | **10.58** |

TokenPilot achieves:
- **95.7% fewer input tokens** vs. Vanilla (cache miss: 9.928M vs. 21.981M)
- **87.0% lower cost** vs. Vanilla ($10.58 vs. $81.52)
- **Massive cache read reduction** (21.43M vs. 709.85M — 97% reduction)

### Isolated Mode

| Method | Overall Score | Cache Read (M) | Cache Miss (M) | Output (M) | Cost ($) |
| :-- | --: | --: | --: | --: | --: |
| Vanilla | **64.5** | 9.429 | 4.637 | 0.216 | 5.16 |
| TokenPilot | 63.1 | **4.436** | **1.154** | 0.239 | **2.27** |

TokenPilot achieves the lowest cache miss and lowest cost in isolated mode as well.

## Key Takeaways

1. **Cache miss is dramatically lower**: TokenPilot's stable prefix ensures consistent cache hits.
2. **Cost scales better**: Vanilla cost grows with session length; TokenPilot cost stays flat.
3. **Quality is maintained**: Task success is competitive or better across both benchmarks.
4. **Continuous is where it shines**: The longer the session, the bigger TokenPilot's advantage.

## Reproducing Results

See [experiments/README.md](https://github.com/zjunlp/LightMem2/blob/main/experiments/README.md) in the repository for:
- Environment setup
- Data download links
- Runner commands
- Output directory structure
