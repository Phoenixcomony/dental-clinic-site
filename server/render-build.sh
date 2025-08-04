#!/usr/bin/env bash
# Install Chrome for Puppeteer in Render
apt-get update && apt-get install -y wget gnupg2
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y ./google-chrome-stable_current_amd64.deb

#!/usr/bin/env bash
set -e

# تثبيت Google Chrome المناسب لـ Puppeteer في ريندر
if ! [ -x "$(command -v google-chrome)" ]; then
  echo "تثبيت Google Chrome..."
  apt-get update
  apt-get install -y wget
  wget -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y /tmp/chrome.deb
fi

# تثبيت المتصفحات المطلوبة لـ Puppeteer (لو احتجت)
npx puppeteer browsers install chrome

echo "✅ Google Chrome متوفر وجاهز لـ Puppeteer"
