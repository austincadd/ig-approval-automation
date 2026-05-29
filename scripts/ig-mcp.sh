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

SERVER="ig-looter"

tool() {
  local name="$1"
  printf '%s.%s' "$SERVER" "$name"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)
    mcporter --config "$CONFIG" list "$SERVER"
    ;;
  search-users)
    query="${1:-}"; select="${2:-users}"
    if [[ -z "$query" ]]; then echo "Usage: ig-mcp.sh search-users <query> [select]"; exit 1; fi
    mcporter --config "$CONFIG" call "$(tool Search_users_by_keyword)" query="$query" select="$select"
    ;;
  related)
    user_id="${1:-}"
    if [[ -z "$user_id" ]]; then echo "Usage: ig-mcp.sh related <user_id>"; exit 1; fi
    mcporter --config "$CONFIG" call "$(tool Related_profiles_by_user_ID)" id:"$user_id"
    ;;
  hashtag-media)
    hashtag="${1:-}"; end_cursor="${2:-}"
    if [[ -z "$hashtag" ]]; then echo "Usage: ig-mcp.sh hashtag-media <hashtag> [end_cursor]"; exit 1; fi
    if [[ -n "$end_cursor" ]]; then
      mcporter --config "$CONFIG" call "$(tool Media_by_hashtag)" query="$hashtag" end_cursor="$end_cursor"
    else
      mcporter --config "$CONFIG" call "$(tool Media_by_hashtag)" query="$hashtag"
    fi
    ;;
  hashtag-search)
    query="${1:-}"; select="${2:-hashtags}"
    if [[ -z "$query" ]]; then echo "Usage: ig-mcp.sh hashtag-search <query> [select]"; exit 1; fi
    mcporter --config "$CONFIG" call "$(tool Search_users_by_keyword)" query="$query" select="$select"
    ;;
  profile)
    username="${1:-}"
    if [[ -z "$username" ]]; then echo "Usage: ig-mcp.sh profile <username>"; exit 1; fi
    mcporter --config "$CONFIG" call "$(tool Web_profile_info_by_username)" username="$username"
    ;;
  help|*)
    cat <<EOF
IG MCP shortcuts

  scripts/ig-mcp.sh list
  scripts/ig-mcp.sh search-users <query> [select]
  scripts/ig-mcp.sh related <user_id>
  scripts/ig-mcp.sh hashtag-media <hashtag> [end_cursor]
  scripts/ig-mcp.sh hashtag-search <query> [select]
  scripts/ig-mcp.sh profile <username>

Examples:
  scripts/ig-mcp.sh search-users "quran"
  scripts/ig-mcp.sh hashtag-search "ai"
  scripts/ig-mcp.sh hashtag-media "ai"
  scripts/ig-mcp.sh related 25025320
EOF
    ;;
esac
