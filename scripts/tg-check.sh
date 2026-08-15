#!/usr/bin/env bash
# Telegram alerting verification. Reads the token from .env and never prints it.
#
#   ./scripts/tg-check.sh            # verify token, discover chat id
#   ./scripts/tg-check.sh send <id>  # send a real test message
#
# See OPERATIONS.md "Alerting destination — Telegram".
set -euo pipefail
cd "$(dirname "$0")/.."

# Read only the two keys we need, rather than sourcing .env. Sourcing executes
# the file, so a value containing spaces or shell metacharacters (dotenv trims
# these fine, the shell does not) fails as a stray command — and it would also
# pull every unrelated secret in the file into this process for no reason.
read_env() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" ./.env \
    | head -n1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" \
    | tr -d '\r'
}

TELEGRAM_BOT_TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
TELEGRAM_ALERT_CHAT_ID="$(read_env TELEGRAM_ALERT_CHAT_ID)"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "TELEGRAM_BOT_TOKEN is not set in .env" >&2
  exit 1
fi

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

if [ "${1:-}" = "send" ]; then
  chat="${2:-${TELEGRAM_ALERT_CHAT_ID:-}}"
  if [ -z "$chat" ]; then
    echo "usage: $0 send <chat_id>   (or set TELEGRAM_ALERT_CHAT_ID)" >&2
    exit 1
  fi
  curl -s -X POST "${API}/sendMessage" \
    -H 'Content-Type: application/json' \
    -d "{\"chat_id\":\"${chat}\",\"text\":\"zypp relayer — alerting verification. If you can read this, breaker alerts will arrive here.\"}" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("delivered" if d.get("ok") else "FAILED: %s %s" % (d.get("error_code"), d.get("description")))'
  exit 0
fi

echo "--- getMe ---"
curl -s "${API}/getMe" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("ok"):
    print("token REJECTED: %s %s" % (d.get("error_code"), d.get("description")))
    raise SystemExit(1)
r = d["result"]
print("token valid | bot: @%s | id: %s" % (r.get("username"), r.get("id")))
'

echo
echo "--- getUpdates (chat id discovery) ---"
curl -s "${API}/getUpdates" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("ok"):
    print("FAILED: %s %s" % (d.get("error_code"), d.get("description")))
    raise SystemExit(1)
results = d.get("result", [])
if not results:
    print("no updates. Send a message in the group, then re-run.")
    print("note: getUpdates only returns messages sent AFTER the token was rotated,")
    print("      and each update is consumed once read.")
    raise SystemExit(0)
seen = {}
for u in results:
    msg = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
    chat = msg.get("chat") or {}
    if chat.get("id") is not None:
        seen[chat["id"]] = (chat.get("type"), chat.get("title") or chat.get("username") or chat.get("first_name"))
for cid, (ctype, title) in seen.items():
    print("chat id: %-16s type: %-10s name: %s" % (cid, ctype, title))
'
