FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends tmux git curl jq sqlite3 procps less python3 build-essential && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex @openrig/cli
RUN useradd -m -s /bin/bash rigger
USER rigger
WORKDIR /home/rigger
ENV TERM=xterm-256color
CMD ["sleep","infinity"]
