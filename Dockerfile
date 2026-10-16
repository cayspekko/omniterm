# syntax=docker/dockerfile:1

# ---- Build: produce the same @omniterm/host tarball the release publishes ----
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# `pnpm pack` runs prepack (scripts/package.sh) and rewrites workspace:* deps.
RUN cd apps/omniterm && pnpm pack --pack-destination /out

# ---- Runtime ----
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux chromium xvfb git curl ca-certificates procps less vim-tiny \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# ttyd isn't packaged in bookworm; use the upstream static binary.
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) a=x86_64 ;; arm64) a=aarch64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${a}" \
 && chmod 755 /usr/local/bin/ttyd \
 && ttyd --version

# omniterm-browser honours OMNITERM_CHROME_PATH, so point it at a wrapper that:
#  - disables Chrome's sandbox, which can't start in an unprivileged container;
#  - sets the window size and pixel density the page starts at (the browser
#    panel then resizes the page to match itself);
#  - stops reporting navigator.webdriver=true. Chrome sets it for any browser
#    with remote debugging on, and the panel needs remote debugging to show the
#    page at all — but a person is the one driving it;
#  - keeps WebGL on the software renderer. Without a GPU, headed Chrome
#    otherwise disables WebGL outright, which breaks sites and stands out.
COPY <<'EOF' /usr/local/bin/chromium-nosandbox
#!/bin/sh
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --enable-unsafe-swiftshader \
  --window-size="${OMNITERM_BROWSER_WINDOW_SIZE:-1440,900}" \
  --force-device-scale-factor="${OMNITERM_BROWSER_SCALE:-2}" \
  "$@"
EOF
RUN chmod 755 /usr/local/bin/chromium-nosandbox

COPY --from=build /out/*.tgz /tmp/omniterm.tgz
RUN npm install -g --allow-scripts=@omniterm/host /tmp/omniterm.tgz && rm /tmp/omniterm.tgz

# Chrome runs headed on a virtual display rather than with --headless. Headless
# Chrome announces itself to every site it visits (a "HeadlessChrome" user
# agent, navigator.webdriver=true, a 400x300 screen), which is what gets it
# flagged as a bot. omniterm-browser goes headed whenever $DISPLAY is set.
# The screen is 4K so a 2x-scaled window still fits on it.
COPY <<'EOF' /usr/local/bin/omniterm-entrypoint
#!/bin/sh
set -e
display_number="${DISPLAY#:}"
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
Xvfb "$DISPLAY" -screen 0 "${OMNITERM_XVFB_SCREEN:-3840x2160x24}" -nolisten tcp >/dev/null 2>&1 &
exec "$@"
EOF
RUN chmod 755 /usr/local/bin/omniterm-entrypoint

# Terminals start from a scrubbed env; let these through to them.
ENV DISPLAY=:99 \
    OMNITERM_CHROME_PATH=/usr/local/bin/chromium-nosandbox \
    OMNITERM_ENV_PASSTHROUGH=DISPLAY,TZ,OMNITERM_CHROME_PATH,OMNITERM_BROWSER_WINDOW_SIZE,OMNITERM_BROWSER_SCALE \
    OMNITERM_HOST=0.0.0.0 \
    OMNITERM_PORT=17717 \
    SHELL=/bin/bash

# omniterm only browses files under $HOME, so run as a normal user.
USER node
WORKDIR /home/node
RUN mkdir -p /home/node/.omniterm /home/node/work
EXPOSE 17717
ENTRYPOINT ["/usr/local/bin/omniterm-entrypoint"]
CMD ["omniterm"]
