#!/usr/bin/env bash
# Provision a VPS to run the Hik-Connect attendance scraper on a real cron.
#
# Replaces the GitHub Actions schedule, which delivers 30-45 minutes late because
# GitHub throttles */5 cron triggers. A systemd timer on your own box fires on
# time, every time.
#
# Run as root on a fresh Ubuntu 22.04/24.04 droplet:
#   bash setup.sh
#
# Re-running is safe — it updates the checkout and restarts the timer.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ifrah87/cleaning.git}"
APP_DIR="${APP_DIR:-/opt/cleaning}"
ENV_FILE="/etc/cleaning-scraper.env"
TZ_NAME="${TZ_NAME:-Africa/Mogadishu}"      # EAT — the timer's window is in local time
WINDOW="${WINDOW:-06..19}"                  # hours to run; :0/5 = every 5 minutes

log() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash setup.sh)"; exit 1; }

log "Setting timezone to $TZ_NAME so the schedule matches the crew's day"
timedatectl set-timezone "$TZ_NAME"

log "Installing Node.js 20 and git"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git ca-certificates

# Chromium needs roughly 1GB free. The cheapest droplets have 512MB-1GB, so add
# swap rather than silently OOM-killing the scrape halfway through.
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2000 ] && [ ! -f /swapfile ]; then
  log "Adding 2G swap (small droplet, Chromium needs headroom)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Fetching the scraper into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

log "Installing dependencies and Chromium"
cd "$APP_DIR/scraper"
npm install --no-audit --no-fund
npx playwright install --with-deps chromium

# Credentials live outside the repo, root-only. Never in git.
if [ ! -f "$ENV_FILE" ]; then
  log "Creating $ENV_FILE — FILL THIS IN, then re-run or start the timer"
  cat > "$ENV_FILE" <<'EOF'
HIK_EMAIL=
HIK_PASSWORD=
SUPABASE_URL=https://issnrivggzkhrcjfhzit.supabase.co
SUPABASE_SERVICE_KEY=
EOF
  chmod 600 "$ENV_FILE"
fi

log "Installing the systemd service + timer"
cat > /etc/systemd/system/cleaning-scraper.service <<EOF
[Unit]
Description=Hik-Connect attendance scrape
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR/scraper
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node scrape.js
# One run should never take minutes; kill it rather than overlap the next tick.
TimeoutStartSec=300
Nice=10
EOF

cat > /etc/systemd/system/cleaning-scraper.timer <<EOF
[Unit]
Description=Run the attendance scrape every 5 minutes during working hours

[Timer]
OnCalendar=$WINDOW:0/5
Persistent=true
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now cleaning-scraper.timer

log "Done."
echo
echo "  Credentials : $ENV_FILE  (fill in HIK_EMAIL, HIK_PASSWORD, SUPABASE_SERVICE_KEY)"
echo "  Run one now : systemctl start cleaning-scraper.service"
echo "  Watch logs  : journalctl -u cleaning-scraper.service -f"
echo "  Next runs   : systemctl list-timers cleaning-scraper.timer"
echo
echo "  Once this is confirmed working, disable the GitHub Actions schedule so the"
echo "  two aren't scraping in parallel — see scraper/deploy/README.md."
