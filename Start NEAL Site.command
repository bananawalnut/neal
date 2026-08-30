#!/bin/zsh
set -e

cd "$(dirname "$0")"

URL="http://127.0.0.1:4280/"

npm run site:build
(sleep 0.8; open "$URL") &

echo "NEAL verification site is running at $URL"
echo "Keep this window open while using the site. Press Control-C to stop."
exec python3 -m http.server 4280 --bind 127.0.0.1 --directory apps/site/dist
