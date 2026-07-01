#!/usr/bin/env bash
set -u

OUT="${1:-omp-report-$(date +%Y%m%d-%H%M%S).md}"

section() {
  {
    echo
    echo "## $1"
    echo
  } >> "$OUT"
}

run_cmd() {
  local title="$1"
  shift

  {
    echo
    echo "### $title"
    echo
    echo '```text'
    "$@" 2>&1 || echo "[command failed: $*]"
    echo '```'
  } >> "$OUT"
}

run_shell() {
  local title="$1"
  local cmd="$2"

  {
    echo
    echo "### $title"
    echo
    echo '```text'
    bash -lc "$cmd" 2>&1 || echo "[command failed: $cmd]"
    echo '```'
  } >> "$OUT"
}

safe_cat_file() {
  local title="$1"
  local file="$2"

  {
    echo
    echo "### $title"
    echo
    echo "Path: \`$file\`"
    echo
    echo '```yaml'
    if [[ -f "$file" ]]; then
      sed -E '
        s/([A-Za-z_]*API[_-]?KEY[A-Za-z_]*:?[[:space:]]*).*/\1[REDACTED]/Ig;
        s/([A-Za-z_]*TOKEN[A-Za-z_]*:?[[:space:]]*).*/\1[REDACTED]/Ig;
        s/([A-Za-z_]*SECRET[A-Za-z_]*:?[[:space:]]*).*/\1[REDACTED]/Ig;
        s/([A-Za-z_]*PASSWORD[A-Za-z_]*:?[[:space:]]*).*/\1[REDACTED]/Ig;
        s/(Authorization:[[:space:]]*Bearer[[:space:]]+).*/\1[REDACTED]/Ig;
        s/(sk-[A-Za-z0-9_-]{20,})/[REDACTED_OPENAI_KEY]/g;
        s/(sess-[A-Za-z0-9_-]{20,})/[REDACTED_SESSION]/g;
      ' "$file"
    else
      echo "[missing]"
    fi
    echo '```'
  } >> "$OUT"
}

redacted_env() {
  env | sort | sed -E '
    s/(OPENAI_API_KEY=).*/\1[REDACTED]/;
    s/(ANTHROPIC_API_KEY=).*/\1[REDACTED]/;
    s/(GITHUB_TOKEN=).*/\1[REDACTED]/;
    s/(.*TOKEN.*=).*/\1[REDACTED]/I;
    s/(.*SECRET.*=).*/\1[REDACTED]/I;
    s/(.*PASSWORD.*=).*/\1[REDACTED]/I;
    s/(.*KEY.*=).*/\1[REDACTED]/I;
  '
}

{
  echo "# oh-my-pi Diagnostic Report"
  echo
  echo "- Generated: $(date -Is)"
  echo "- Hostname: $(hostname 2>/dev/null || echo unknown)"
  echo "- User: $(whoami 2>/dev/null || echo unknown)"
  echo "- Shell: ${SHELL:-unknown}"
  echo "- PWD: $(pwd)"
} > "$OUT"

section "System"
run_cmd "uname" uname -a
run_shell "OS release" 'cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || systeminfo 2>/dev/null | head -60'
run_shell "CPU" 'sysctl -n machdep.cpu.brand_string 2>/dev/null || lscpu 2>/dev/null | head -40'
run_shell "Memory" 'vm_stat 2>/dev/null | head -40 || free -h 2>/dev/null'
run_shell "Disk" 'df -h . "$HOME" 2>/dev/null'
run_shell "Network interfaces" 'ifconfig 2>/dev/null | sed -E "s/(ether )[0-9a-f:]+/\1[REDACTED_MAC]/Ig" || ip addr 2>/dev/null | sed -E "s/(link\/ether )[0-9a-f:]+/\1[REDACTED_MAC]/Ig"'

section "oh-my-pi Binary"
run_shell "omp location" 'command -v omp || true'
run_shell "omp version" 'omp --version 2>&1 || true'
run_shell "omp help" 'omp --help 2>&1 | head -120 || true'
run_shell "omp package paths" 'which omp 2>/dev/null; ls -la "$(which omp 2>/dev/null)" 2>/dev/null || true'

section "Runtime Versions"
run_shell "node" 'command -v node && node --version || true'
run_shell "npm" 'command -v npm && npm --version || true'
run_shell "bun" 'command -v bun && bun --version || true'
run_shell "pnpm" 'command -v pnpm && pnpm --version || true'
run_shell "yarn" 'command -v yarn && yarn --version || true'

section "Installed oh-my-pi Packages"
run_shell "npm global packages" 'npm list -g --depth=1 2>/dev/null | grep -iE "oh-my-pi|omp|pi-" || true'
run_shell "bun global packages" 'bun pm ls -g 2>/dev/null | grep -iE "oh-my-pi|omp|pi-" || true'
run_shell "package manager global roots" 'echo "npm root: $(npm root -g 2>/dev/null)"; echo "bun install cache: ${BUN_INSTALL:-$HOME/.bun}"'

section "Environment"
{
  echo
  echo "### Redacted environment"
  echo
  echo '```text'
  redacted_env
  echo '```'
} >> "$OUT"

section "Proxy, DNS, and TLS"
run_shell "proxy env vars" 'env | grep -iE "proxy|ssl|cert|ca_bundle|openai" | sed -E "s/(OPENAI_API_KEY=).*/\1[REDACTED]/; s/(.*KEY.*=).*/\1[REDACTED]/I; s/(.*TOKEN.*=).*/\1[REDACTED]/I" || true'
run_shell "macOS proxy settings" 'scutil --proxy 2>/dev/null || true'
run_shell "macOS DNS" 'scutil --dns 2>/dev/null | head -160 || true'
run_shell "Linux DNS" 'cat /etc/resolv.conf 2>/dev/null || true'
run_shell "OpenSSL version" 'openssl version 2>/dev/null || true'

section "OpenAI Connectivity"
run_shell "OpenAI models endpoint HTTP status" '
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    curl -sS -o /tmp/omp-openai-models.json -w "http_code=%{http_code}\ntime_total=%{time_total}\nremote_ip=%{remote_ip}\nssl_verify=%{ssl_verify_result}\n" \
      https://api.openai.com/v1/models \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      --connect-timeout 10 \
      --max-time 30
    rm -f /tmp/omp-openai-models.json
  else
    echo "OPENAI_API_KEY is not set in this shell."
  fi
'
run_shell "Repeated OpenAI connectivity test" '
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    for i in 1 2 3 4 5; do
      printf "attempt=%s " "$i"
      curl -sS -o /dev/null -w "http_code=%{http_code} time_total=%{time_total} remote_ip=%{remote_ip}\n" \
        https://api.openai.com/v1/models \
        -H "Authorization: Bearer $OPENAI_API_KEY" \
        --connect-timeout 10 \
        --max-time 30 || echo "curl_failed"
      sleep 2
    done
  else
    echo "OPENAI_API_KEY is not set in this shell."
  fi
'

section "oh-my-pi Config Files"
safe_cat_file "Main config: ~/.omp/config.yml" "$HOME/.omp/config.yml"
safe_cat_file "Agent config: ~/.omp/agent/config.yml" "$HOME/.omp/agent/config.yml"
safe_cat_file "Models config: ~/.omp/models.yml" "$HOME/.omp/models.yml"
safe_cat_file "Agent models config: ~/.omp/agent/models.yml" "$HOME/.omp/agent/models.yml"
safe_cat_file "Settings: ~/.omp/settings.yml" "$HOME/.omp/settings.yml"
safe_cat_file "Agent settings: ~/.omp/agent/settings.yml" "$HOME/.omp/agent/settings.yml"

section "oh-my-pi Directory State"
run_shell "~/.omp tree" '
  if command -v tree >/dev/null 2>&1; then
    tree -a -L 4 "$HOME/.omp" 2>/dev/null
  else
    find "$HOME/.omp" -maxdepth 4 -print 2>/dev/null | sort
  fi
'
run_shell "~/.omp sizes" 'du -sh "$HOME/.omp" "$HOME/.omp/"* 2>/dev/null | sort -h || true'
run_shell "Potential model/cache DBs" 'find "$HOME/.omp" "$HOME/.cache" -iname "*model*" -o -iname "*.sqlite" 2>/dev/null | sort | head -200'

section "oh-my-pi Logs and Recent Errors"
run_shell "Log file candidates" '
  find "$HOME/.omp" "$HOME/.cache" "$HOME/Library/Logs" -maxdepth 6 \
    \( -iname "*omp*" -o -iname "*oh-my-pi*" -o -iname "*.log" \) 2>/dev/null \
    | sort | head -200
'
run_shell "Socket closed errors in ~/.omp and ~/.cache" '
  grep -RIn --exclude-dir=node_modules --exclude-dir=.git \
    -E "socket connection was closed unexpectedly|socket closed|ECONNRESET|EPIPE|ETIMEDOUT|APIConnectionError|stream.*closed|closed unexpectedly" \
    "$HOME/.omp" "$HOME/.cache" 2>/dev/null | tail -200 || true
'

section "Project-local OMP Files"
run_shell "Current project OMP files" '
  find . -maxdepth 5 \
    \( -iname "*omp*" -o -iname ".omp" -o -iname "models.yml" -o -iname "config.yml" \) \
    -not -path "*/node_modules/*" \
    -not -path "*/.git/*" \
    2>/dev/null | sort | head -200
'

section "Git Context"
run_shell "Current repo" 'git rev-parse --show-toplevel 2>/dev/null || true'
run_shell "Current branch/status" 'git status --short --branch 2>/dev/null || true'
run_shell "Remotes" 'git remote -v 2>/dev/null | sed -E "s#(https://)[^/@]+@#\1[REDACTED]@#g" || true'

section "Shell Limits"
run_shell "ulimit" 'ulimit -a'
run_shell "open files limit" 'launchctl limit maxfiles 2>/dev/null || true'

section "Report Notes"
{
  echo
  echo "- Secrets were redacted by pattern, but review this file before sharing."
  echo "- If socket errors appear only during large edits/writes, include the task description and approximate file size."
  echo "- If errors appear only on one network, run this report once on that network and once on a different network."
} >> "$OUT"

echo "Report written to: $OUT"