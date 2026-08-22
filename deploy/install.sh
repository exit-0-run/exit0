#!/usr/bin/env bash
# Stawia rejestr na czystym Debianie/Ubuntu. Odpalane jako root.
set -euo pipefail

DIR=/srv/open-problems
USER=openproblems

command -v node >/dev/null || { echo "brak node — zainstaluj Node 20+"; exit 1; }
command -v git  >/dev/null || { echo "brak git"; exit 1; }

id "$USER" &>/dev/null || useradd --system --home "$DIR" --shell /usr/sbin/nologin "$USER"

mkdir -p "$DIR"
cp -r problems scripts README.md llms.txt DESIGN.md .gitignore "$DIR/"

cd "$DIR"
node scripts/build.mjs
if [ ! -d .git ]; then
  git init -q
  git config user.email "registry@localhost"
  git config user.name  "open-problems"
  git add -A && git commit -qm "init"
fi

chown -R "$USER:$USER" "$DIR"
git config --global --add safe.directory "$DIR" || true

cp deploy/open-problems.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now open-problems

echo
echo "stoi. sprawdz:  curl -s localhost:8080/api/pulse"
echo "TLS:            skopiuj deploy/Caddyfile do /etc/caddy/, podmien domene, systemctl reload caddy"
echo "kopia:          dopisz do crona  cd $DIR && git push --mirror <url>"
