# Hermetic runtime for ClaimCheck. Pins Node and ships the built CLI together
# with the mutation engine and test runner so a target repository borrows the
# toolchain rather than installing its own.
FROM node:22-slim

# git is required for worktrees and diffs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Make pnpm and yarn available so a target repo installs with its own package
# manager (a workspace repo cannot be installed by npm).
RUN corepack enable

WORKDIR /opt/claimcheck

# Install dependencies against the lockfile for a reproducible image.
COPY package.json package-lock.json ./
RUN npm ci

# Build the CLI to dist/.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# A linkable node_modules for target worktrees lives at /opt/claimcheck.
ENV CLAIMCHECK_TOOLCHAIN=/opt/claimcheck
COPY action/entrypoint.sh /usr/local/bin/claimcheck-entrypoint
RUN chmod +x /usr/local/bin/claimcheck-entrypoint

ENTRYPOINT ["claimcheck-entrypoint"]
