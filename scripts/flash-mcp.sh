#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT_DIR/config/mcporter.json"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

if [[ -z "${RAPIDAPI_KEY:-}" ]]; then
  echo "RAPIDAPI_KEY missing. Add it to $ROOT_DIR/.env"
  exit 1
fi

SERVER="flashapi"

tool() {
  local name="$1"
  printf '%s.%s' "$SERVER" "$name"
}

mcp_call() {
  local out status
  out="$(mcporter --config "$CONFIG" call "$@" 2>&1)"
  status=$?
  if [[ $status -ne 0 ]]; then
    printf '%s\n' "$out" >&2
    return $status
  fi

  if [[ -z "${out//[[:space:]]/}" ]]; then
    printf 'flash-mcp.sh: empty response from mcporter for call: %s\n' "$*" >&2
    printf 'flash-mcp.sh: RAPIDAPI_KEY %sset in environment\n' "${RAPIDAPI_KEY:+}" >&2
    return 70
  fi

  printf '%s\n' "$out"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)
    mcporter --config "$CONFIG" list "$SERVER"
    ;;
  user-id)
    user="${1:-}"
    if [[ -z "$user" ]]; then echo "Usage: flash-mcp.sh user-id <username>"; exit 1; fi
    mcp_call "$(tool User_ID)" user="$user"
    ;;
  followers)
    id_user="${1:-}"; next_max_id="${2:-}"
    if [[ -z "$id_user" ]]; then echo "Usage: flash-mcp.sh followers <id_user> [next_max_id]"; exit 1; fi
    if [[ -n "$next_max_id" ]]; then
      mcp_call "$(tool Followers)" id_user="$id_user" next_max_id="$next_max_id"
    else
      mcp_call "$(tool Followers)" id_user="$id_user"
    fi
    ;;
  similar)
    id_user="${1:-}"
    if [[ -z "$id_user" ]]; then echo "Usage: flash-mcp.sh similar <id_user>"; exit 1; fi
    mcp_call "$(tool Similar_Accounts)" id_user:"$id_user"
    ;;
  media)
    shortcode="${1:-}"
    if [[ -z "$shortcode" ]]; then echo "Usage: flash-mcp.sh media <shortcode>"; exit 1; fi
    mcp_call "$(tool Media)" shortcode="$shortcode"
    ;;
  media-comments)
    shortcode="${1:-}"; end_cursor="${2:-}"
    if [[ -z "$shortcode" ]]; then echo "Usage: flash-mcp.sh media-comments <shortcode> [end_cursor]"; exit 1; fi
    if [[ -n "$end_cursor" ]]; then
      mcp_call "$(tool Media_Comments)" shortcode="$shortcode" end_cursor="$end_cursor"
    else
      mcp_call "$(tool Media_Comments)" shortcode="$shortcode"
    fi
    ;;
  user-posts)
    id_user="${1:-}"; end_cursor="${2:-}"
    if [[ -z "$id_user" ]]; then echo "Usage: flash-mcp.sh user-posts <id_user> [end_cursor]"; exit 1; fi
    if [[ -n "$end_cursor" ]]; then
      mcp_call "$(tool User_Posts)" id_user:"$id_user" end_cursor="$end_cursor"
    else
      mcp_call "$(tool User_Posts)" id_user:"$id_user"
    fi
    ;;
  user-posts-username)
    user="${1:-}"; end_cursor="${2:-}"
    if [[ -z "$user" ]]; then echo "Usage: flash-mcp.sh user-posts-username <username> [end_cursor]"; exit 1; fi
    if [[ -n "$end_cursor" ]]; then
      mcp_call "$(tool User_Posts_by_Username)" user="$user" end_cursor="$end_cursor"
    else
      mcp_call "$(tool User_Posts_by_Username)" user="$user"
    fi
    ;;
  help|*)
    cat <<EOF
FlashAPI MCP shortcuts

  scripts/flash-mcp.sh list
  scripts/flash-mcp.sh user-id <username>
  scripts/flash-mcp.sh followers <id_user> [next_max_id]
  scripts/flash-mcp.sh similar <id_user>
  scripts/flash-mcp.sh media <shortcode>
  scripts/flash-mcp.sh media-comments <shortcode> [end_cursor]
  scripts/flash-mcp.sh user-posts <id_user> [end_cursor]
  scripts/flash-mcp.sh user-posts-username <username> [end_cursor]
EOF
    ;;
esac
