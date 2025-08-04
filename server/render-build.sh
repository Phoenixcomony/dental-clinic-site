#!/usr/bin/env bash
# Install Chrome for Puppeteer in Render
apt-get update && apt-get install -y wget gnupg2
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y ./google-chrome-stable_current_amd64.deb
