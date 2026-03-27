#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-all}"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
FIXTURE="${ECOCLAW_ACCEPTANCE_FIXTURE:-$PKG_DIR/fixtures/responses-cache-bridge-session.jsonl}"
SESSION_DIR="${OPENCLAW_SESSION_DIR:-$HOME/.openclaw/agents/main/sessions}"
OUT_DIR="${ECOCLAW_ACCEPTANCE_OUT_DIR:-$PKG_DIR/.tmp/cache-acceptance}"
TARGET_CLEAN_RUNS="${TARGET_CLEAN_RUNS:-2}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-6}"
CACHE_THRESHOLD="${CACHE_THRESHOLD:-9000}"
SLEEP_SECONDS="${SLEEP_SECONDS:-5}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

mkdir -p "$OUT_DIR" "$SESSION_DIR"

if [[ ! -f "$FIXTURE" ]]; then
  echo "fixture not found: $FIXTURE" >&2
  exit 2
fi

case "$MODE" in
  all|multi|fork) ;;
  *)
    echo "usage: $0 [all|multi|fork]" >&2
    exit 2
    ;;
esac

extract_json() {
  sed -n '/^{/,$p'
}

record_result() {
  local group="$1"
  local sid="$2"
  local msg="$3"
  local res="$4"
  local out="$5"
  printf '%s\n' "$res" | GROUP="$group" SID="$sid" MSG="$msg" node -e '
const fs=require("fs");
const obj=JSON.parse(fs.readFileSync(0,"utf8"));
const meta=obj.result?.meta?.agentMeta||{};
console.log(JSON.stringify({
  group:process.env.GROUP,
  sessionId:process.env.SID,
  message:process.env.MSG,
  runId:obj.runId,
  usage:meta.lastCallUsage||meta.usage||{},
  promptTokens:meta.promptTokens??null,
  provider:meta.provider??null,
  model:meta.model??null
}));' >> "$out"
}

seed_fixture() {
  local sid="$1"
  local dest="$SESSION_DIR/${sid}.jsonl"
  node -e '
const fs=require("fs");
const sid=process.argv[1];
const src=process.argv[2];
const lines=fs.readFileSync(src,"utf8").trim().split(/\n+/);
const now=new Date().toISOString();
const out=lines.map((line,idx)=>{
  const obj=JSON.parse(line);
  if(idx===0){ obj.id=sid; obj.timestamp=now; }
  return JSON.stringify(obj);
}).join("\n")+"\n";
fs.writeFileSync(process.argv[3], out);
' "$sid" "$FIXTURE" "$dest"
}

is_clean_run() {
  local kind="$1"
  local file="$2"
  node - "$kind" "$file" "$CACHE_THRESHOLD" <<'NODE'
const fs=require('fs');
const kind=process.argv[2];
const file=process.argv[3];
const threshold=Number(process.argv[4]);
const rows=fs.readFileSync(file,'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse);
const map=new Map(rows.map((row)=>[row.group,row]));
const groups = kind === 'multi'
  ? ['task1','task2','task3']
  : ['fork_A','fork_B','fork_C'];
const ok = groups.every((group) => Number(map.get(group)?.usage?.cacheRead ?? 0) >= threshold);
process.stdout.write(ok ? '1' : '0');
NODE
}

print_summary_table() {
  local title="$1"
  local file="$2"
  echo "$title"
  local table
  table=$(node - "$file" <<'NODE'
const fs=require('fs');
const rows=fs.readFileSync(process.argv[2],'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse);
console.log('group\tinput\toutput\tcacheRead\ttotal');
for (const row of rows) {
  const u=row.usage||{};
  console.log(`${row.group}\t${u.input ?? '-'}\t${u.output ?? '-'}\t${u.cacheRead ?? '-'}\t${u.total ?? '-'}`);
}
NODE
)
  echo "$table"
  echo
  {
    echo "$title"
    echo
    echo '```text'
    echo "$table"
    echo '```'
    echo
  } >> "$SUMMARY_MD"
}

run_multi_once() {
  local out="$1"
  : > "$out"
  local ts sid bridge task1 task2 task3 res
  ts=$(date +%s)
  sid="ecoclaw-accept-multi-${ts}"
  seed_fixture "$sid"
  bridge='bridge turn: reply exactly BRIDGE_OK'
  task1='task A weather style: reply exactly TASK_A'
  task2='task B files style: reply exactly TASK_B'
  task3='task C coding style: reply exactly TASK_C'

  res=$($OPENCLAW_BIN agent --session-id "$sid" --message "$bridge" --json | extract_json)
  record_result bridge "$sid" "$bridge" "$res" "$out"
  sleep "$SLEEP_SECONDS"
  res=$($OPENCLAW_BIN agent --session-id "$sid" --message "$task1" --json | extract_json)
  record_result task1 "$sid" "$task1" "$res" "$out"
  sleep "$SLEEP_SECONDS"
  res=$($OPENCLAW_BIN agent --session-id "$sid" --message "$task2" --json | extract_json)
  record_result task2 "$sid" "$task2" "$res" "$out"
  sleep "$SLEEP_SECONDS"
  res=$($OPENCLAW_BIN agent --session-id "$sid" --message "$task3" --json | extract_json)
  record_result task3 "$sid" "$task3" "$res" "$out"
}

run_fork_once() {
  local out="$1"
  : > "$out"
  local ts bridge_sid bridge_msg bridge_res bridge_file lines sid task_msg res pair branch
  ts=$(date +%s)
  bridge_sid="ecoclaw-accept-fork-src-${ts}"
  seed_fixture "$bridge_sid"
  bridge_msg='bridge turn: reply exactly BRIDGE_OK'
  bridge_res=$($OPENCLAW_BIN agent --session-id "$bridge_sid" --message "$bridge_msg" --json | extract_json)
  record_result bridge_source "$bridge_sid" "$bridge_msg" "$bridge_res" "$out"
  bridge_file="$SESSION_DIR/${bridge_sid}.jsonl"
  lines=$(wc -l < "$bridge_file")
  sleep "$SLEEP_SECONDS"

  for pair in \
    'A:task A fork: reply exactly FORK_A' \
    'B:task B fork: reply exactly FORK_B' \
    'C:task C fork: reply exactly FORK_C'
  do
    branch="${pair%%:*}"
    task_msg="${pair#*:}"
    sid="ecoclaw-accept-fork-${ts}-${branch}"
    head -n "$lines" "$bridge_file" | node -e '
const fs=require("fs");
const sid=process.argv[1];
const dest=process.argv[2];
const lines=fs.readFileSync(0,"utf8").trim().split(/\n+/);
const out=lines.map((line,idx)=>{ const obj=JSON.parse(line); if(idx===0){ obj.id=sid; obj.timestamp=new Date().toISOString(); } return JSON.stringify(obj); }).join("\n")+"\n";
fs.writeFileSync(dest,out);
' "$sid" "$SESSION_DIR/${sid}.jsonl"
    res=$($OPENCLAW_BIN agent --session-id "$sid" --message "$task_msg" --json | extract_json)
    record_result "fork_${branch}" "$sid" "$task_msg" "$res" "$out"
    sleep "$SLEEP_SECONDS"
  done
}

collect_clean_runs() {
  local kind="$1"
  local clean=0
  local attempt=0
  while [[ "$clean" -lt "$TARGET_CLEAN_RUNS" && "$attempt" -lt "$MAX_ATTEMPTS" ]]; do
    attempt=$((attempt + 1))
    local out="$OUT_DIR/${kind}_${attempt}_$(date +%s).jsonl"
    echo "[ecoclaw acceptance] kind=$kind attempt=$attempt"
    if [[ "$kind" == "multi" ]]; then
      run_multi_once "$out"
    else
      run_fork_once "$out"
    fi
    print_summary_table "# $kind attempt $attempt" "$out"
    local ok
    ok=$(is_clean_run "$kind" "$out")
    if [[ "$ok" == "1" ]]; then
      clean=$((clean + 1))
      echo "[ecoclaw acceptance] clean run accepted: $out"
      {
        echo "- accepted: \`$out\`"
        echo
      } >> "$SUMMARY_MD"
    else
      echo "[ecoclaw acceptance] noisy run kept for inspection: $out"
      {
        echo "- noisy: \`$out\`"
        echo
      } >> "$SUMMARY_MD"
    fi
    echo
  done
  if [[ "$clean" -lt "$TARGET_CLEAN_RUNS" ]]; then
    echo "[ecoclaw acceptance] failed: only $clean clean $kind runs collected (target=$TARGET_CLEAN_RUNS, attempts=$MAX_ATTEMPTS)" >&2
    return 1
  fi
}

SUMMARY_MD="$OUT_DIR/summary.md"
{
  echo "# EcoClaw Cache Acceptance"
  echo
  echo "- mode: $MODE"
  echo "- target_clean_runs: $TARGET_CLEAN_RUNS"
  echo "- max_attempts: $MAX_ATTEMPTS"
  echo "- cache_threshold: $CACHE_THRESHOLD"
  echo "- fixture: $FIXTURE"
  echo "- session_dir: $SESSION_DIR"
  echo
} > "$SUMMARY_MD"

if [[ "$MODE" == "all" || "$MODE" == "multi" ]]; then
  collect_clean_runs multi
fi
if [[ "$MODE" == "all" || "$MODE" == "fork" ]]; then
  collect_clean_runs fork
fi

echo "acceptance outputs: $OUT_DIR"
echo "summary: $SUMMARY_MD"
