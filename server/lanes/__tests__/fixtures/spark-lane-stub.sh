#!/bin/bash
# Test double for the spark-lane harness. Fully driven by environment variables so
# a test can put the fleet in any state without touching a real node.
#
#   LANE_STUB_LANES  JSON printed for `lanes --json`
#   LANE_STUB_LOG    file that up/down/verify invocations are appended to
#   LANE_STUB_MODE   "hang" -> parent exits while a grandchild holds stdout open
#   LANE_STUB_EXIT   exit code for a normal step (default 0)
#   LANE_STUB_SLOW_LANE  lane id whose step sleeps 3s, to cancel mid-step
case "$1" in
  lanes)
    printf '%s\n' "$LANE_STUB_LANES"
    ;;
  status)
    printf '{"nodes":{},"lanes":[]}\n'
    ;;
  *)
    printf 'INVOKED %s %s\n' "$1" "$2" >> "$LANE_STUB_LOG"
    if [ "$LANE_STUB_MODE" = "hang" ]; then
      # The parent exits immediately; this grandchild inherits our stdout (the pipe
      # Node watches) and holds it open. That is what defers the 'close' event.
      ( sleep 6 ) &
      exit 0
    fi
    if [ -n "$LANE_STUB_SLOW_LANE" ] && [ "$2" = "$LANE_STUB_SLOW_LANE" ]; then
      sleep 3
    fi
    sleep 0.15
    exit "${LANE_STUB_EXIT:-0}"
    ;;
esac