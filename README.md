# RepoRun — Plug-and-Play Environment Setup for GitHub

> One-click setup for any GitHub repo. Click **▶ Run this repo** and get a working, running instance — no local setup, no reading a 40-step README.

![RepoRun](https://img.shields.io/badge/RepoRun-v1.0.0-6366f1?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Required-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=google-chrome&logoColor=white)

## What is RepoRun?

RepoRun is a browser extension that adds a **"▶ Run this repo"** button directly to any GitHub repository page. Clicking it automatically:

1. **Detects** the tech stack (Node.js, Python, Go, Docker, and more)
2. **Provisions** an isolated container environment
3. **Installs** dependencies
4. **Runs** the project
5. **Gives you** a live preview URL and terminal access

No local setup. No Docker knowledge needed. No reading a 40-step README.

## Architecture

```
[Browser Extension]  →  [RepoRun API]  →  [Detection Engine]  →  [Config Generator]
                                         →  [Sandbox Orchestrator]  →  [Docker Containers]
                                         →  [Resolution Engine]  →  [Interactive Prompts]
                                         →  [Session Manager]  →  [Lifecycle & Cleanup]
```

## Project Structure

```
├── extension/          Chrome browser extension (MV3)
│   ├── content/        Injects Run button on GitHub pages
│   ├── popup/          Extension popup UI
│   ├── background/     Service worker
│   └── lib/            Shared API client
│
├── backend/            Node.js API server
│   ├── routes/         REST API endpoints
│   ├── services/       Core business logic
│   │   ├── detectionEngine.js      Stack detection (the hard part)
│   │   ├── configGenerator.js      Dockerfile generation
│   │   ├── sandboxOrchestrator.js  Docker container lifecycle
│   │   ├── resolutionEngine.js     Interactive obstacle handling
│   │   ├── sessionManager.js       Session lifecycle & timeouts
│   │   └── cacheManager.js         Community-trained cache
│   ├── utils/          Helpers (logger, templates, scanner)
│   └── middleware/     Rate limiting, error handling
│
└── dashboard/          Web dashboard for session management
    ├── index.html      Session grid, detail view, terminal
    ├── styles.css      Dark-mode glassmorphism design
    └── app.js          xterm.js terminal, live preview
```

## Prerequisites

- **Node.js** ≥ 18
- **Docker Desktop** running (required for container sandboxing)
- **Chrome** / **Edge** (for the browser extension)

## Quick Start

### 1. Start the Backend

```bash
cd backend
cp .env.example .env   # adjust settings if needed
npm install
npm run dev
```

The server starts at `http://localhost:3000`.  
Dashboard is available at `http://localhost:3000/dashboard`.

### 2. Load the Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Navigate to any GitHub repo page
5. Click the **▶ Run this repo** button!

## Supported Stacks

| Stack | Detection | Confidence |
|-------|----------|------------|
| Node.js (npm/yarn/pnpm/bun) | `package.json`, lockfiles | High |
| Python (pip/poetry/pipenv) | `requirements.txt`, `pyproject.toml`, `Pipfile` | High |
| Go | `go.mod` | High |
| Docker | `Dockerfile`, `docker-compose.yml` | High |
| DevContainers | `.devcontainer/` | High (passthrough) |
| Rust | `Cargo.toml` | Medium |
| Java (Maven/Gradle) | `pom.xml`, `build.gradle` | Medium |
| Ruby | `Gemfile` | Low |
| PHP | `composer.json` | Low |
| Monorepos | `nx.json`, `lerna.json`, `turbo.json` | Medium (with picker) |

## Key Features

### Detection Engine
- File-based heuristic detection with confidence scoring
- Framework detection (Next.js, Express, Django, FastAPI, Gin, etc.)
- Auto-detects required services (Postgres, Redis, MongoDB)
- README fallback: extracts commands from Getting Started sections

### Resolution Engine (Core Differentiator)
- **Missing API keys**: Shows exactly which keys are needed with direct signup links
- **Missing databases**: Auto-provisions ephemeral Postgres/Redis/MongoDB
- **Monorepos**: Detects and offers package picker
- **Ambiguous entrypoint**: Asks for the one missing command
- Every resolution is **cached per-repo** — one person's fix helps the next user

### Security
- Containers run with `--no-new-privileges`, dropped capabilities
- Resource limits (CPU, memory) per session
- Auto-expiry after 30 minutes of inactivity
- Secrets held in-memory only, never stored or logged

## API Endpoints

| Method | Endpoint | Description |
|--------|---------|-------------|
| `POST` | `/api/repo/analyze` | Analyze a repo without running |
| `POST` | `/api/repo/run` | Start the full pipeline |
| `GET` | `/api/repo/status/:sessionId` | SSE progress stream |
| `GET` | `/api/sessions` | List active sessions |
| `GET` | `/api/session/:id` | Session details |
| `DELETE` | `/api/session/:id` | Stop a session |
| `GET` | `/api/resolution/:sessionId` | Get pending prompts |
| `POST` | `/api/resolution/:sessionId` | Submit resolution |
| `GET` | `/api/health` | Health check |

## Configuration

See [`.env.example`](backend/.env.example) for all available settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `SESSION_TIMEOUT_MINUTES` | 30 | Auto-expire after inactivity |
| `MAX_SESSIONS` | 10 | Max concurrent sessions |
| `MAX_CONTAINER_MEMORY` | 512m | Memory limit per container |
| `MAX_REPO_SIZE_MB` | 500 | Max repo clone size |

## License

MIT
