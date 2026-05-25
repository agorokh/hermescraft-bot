#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
API_PORT="${2:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
PROMPT_FILE="${3:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
AGENT_HOME="${4:?Usage: run-landfolk-agent.sh NAME API_PORT PROMPT_FILE HOME_DIR}"
MODEL="${MODEL:-gpt-5.5}"
PROVIDER="${PROVIDER:-openai-codex}"

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# Household play must not silently fall back to Anthropic/Copilot inference.
# Dedicated legacy tests may still opt in by setting MODEL/PROVIDER explicitly.
unset ANTHROPIC_API_KEY || true
unset ANTHROPIC_TOKEN || true
unset CLAUDE_CODE_OAUTH_TOKEN || true

export PATH="$SCRIPT_DIR/bin:$PATH"

until curl -sf "http://localhost:${API_PORT}/health" >/dev/null 2>&1; do
  echo "[$NAME] waiting for bot body on port ${API_PORT}..."
  sleep 1
done

PROMPT="$(cat "$PROMPT_FILE")"

echo "[$NAME] starting Hermes on port ${API_PORT} using ${MODEL}/${PROVIDER}"
HERMES_HOME="$AGENT_HOME" MC_API_URL="http://localhost:${API_PORT}" MC_USERNAME="$NAME" hermes chat --yolo -q "$PROMPT" -m "$MODEL" --provider "$PROVIDER"
