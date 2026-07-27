# PRD: RepoRun — Plug-and-Play Environment Setup for GitHub

## 1. Problem Statement
Cloning a GitHub repo is easy. Getting it *running* is not. Every repo has its own language, dependency manager, system libraries, env variables, and setup quirks. Developers routinely spend 20 minutes to several hours just getting a project to boot before they can evaluate it, contribute to it, or use it.

**RepoRun** is a browser extension that adds a "Run this repo" button directly to any GitHub repository page. Clicking it automatically detects the tech stack, provisions an isolated environment (container-based), installs dependencies, and gives the user a working, running instance — no local setup, no reading a 40-step README.

## 2. Goals

| Goal | Description |
|---|---|
| G1 | One-click setup for the majority of public GitHub repos, with zero manual configuration in the common case |
| G2 | Fast time-to-running-app (target: under 60s for small/medium repos) |
| G3 | Transparent fallback when auto-detection fails — never a silent failure |
| G4 | Safe execution — untrusted code from random repos must not touch the user's machine or data |
| G5 | Works as a lightweight browser extension, not a heavy local install |

## 3. Explicit Non-Goals (Scope Honesty)
"Works on every repo, no exceptions" is not an achievable promise — but the goal of this product is to make that list of true exceptions as short as humanly possible, by treating every obstacle as a **UX/engineering problem to route around** rather than a reason to fail silently. See §7a (Interactive Resolution Engine) for how most "blockers" — missing secrets, missing databases, unusual toolchains, monorepos, even GPU dependencies — get resolved automatically or with a guided prompt instead of a hard failure.

After workarounds, the list of **genuinely unsolvable** cases is short:

- **Legal/licensing restrictions** — proprietary dependencies RepoRun isn't permitted to auto-fetch or run. This is a legal boundary, not a technical one.
- **Repos that are simply broken** — dead upstream services, deleted APIs, code that never worked in the first place. No environment provisioning fixes broken code.
- **Repos that depend on inherently private infrastructure** — an internal company VPN or private API with no public equivalent. There's nothing to provision because the dependency doesn't exist outside that org.

Everything else — API keys, databases, odd build tooling, monorepos, GPU code — should be treated as solvable, either automatically or via a short interactive prompt (§7a).

- **Not a replacement** for GitHub Codespaces/Gitpod — it's complementary. Those require the maintainer to define a devcontainer. RepoRun's job is to work on repos that *haven't* done that, by inferring the config automatically.
- v1 targets **public repos only**. Private repo support (via OAuth) is a fast-follow, not MVP.

The honest pitch: **"instant setup for nearly every repo — and when something's missing, we tell you exactly what and walk you through it in 10 seconds."**

## 4. Target Users
- **Open source contributors** evaluating a repo before deciding to contribute
- **Recruiters/hiring managers & interviewers** who want to quickly run a candidate's project
- **Developers doing tool/library evaluation** ("let me try this out" without polluting their local machine)
- **Students / learners** exploring codebases without fighting environment setup

## 5. Core User Flow

1. User installs the RepoRun browser extension (Chrome/Edge/Firefox).
2. User visits any public GitHub repo page.
3. Extension injects a **"▶ Run this repo"** button next to the existing Code/Fork buttons.
4. On click:
   - Extension sends the repo URL to the RepoRun backend.
   - Backend clones the repo (server-side, not on the user's machine).
   - **Detection engine** scans the repo for manifest files (see §7) to infer language, framework, entrypoint, and required services.
   - Backend generates (or uses an existing) devcontainer/Dockerfile config.
   - Backend builds and starts a container in an isolated sandbox.
   - Backend exposes a URL to a running instance and/or a browser-based terminal/IDE (xterm.js + code-server style).
5. User is dropped into a live, running version of the app / an interactive shell — inside 60 seconds for typical repos.
6. If detection is incomplete or ambiguous, the user sees a **"We detected X, confirm or adjust"** screen instead of a silent failure (e.g., "Looks like a Node app — what's the start command?").
7. Session auto-expires after N minutes of inactivity (cost + safety control).

## 6. System Architecture

```
[Browser Extension]
      │  (injects UI on github.com/*, calls API)
      ▼
[RepoRun API Gateway]
      │
      ├──▶ [Repo Fetcher]        — shallow clone, size/license checks
      ├──▶ [Detection Engine]    — stack inference (see §7)
      ├──▶ [Config Generator]    — produces devcontainer.json / Dockerfile
      ├──▶ [Sandbox Orchestrator]— spins up ephemeral container (Firecracker/gVisor/Docker + seccomp)
      └──▶ [Session Proxy]       — routes running app + terminal back to the browser tab
```

- **Extension** is intentionally thin — all heavy lifting (cloning, building, running) happens server-side in disposable sandboxes, never on the user's machine. This is both a UX win (no local install of Docker etc.) and a security requirement.
- **Sandbox isolation** is non-negotiable: repos are untrusted code by definition. Use microVMs (Firecracker) or gVisor-hardened containers, no network egress by default except what's declared, resource/time limits per session.

## 7. Detection Engine (the hard part)

Heuristic, file-based detection, roughly in this priority order:

| Signal file | Inferred stack |
|---|---|
| `devcontainer.json` / `.devcontainer/` | Use as-is (best case, full trust) |
| `Dockerfile` / `docker-compose.yml` | Use as-is |
| `package.json` | Node.js — read `engines`, `scripts.start`/`dev`, lockfile type (npm/yarn/pnpm) |
| `requirements.txt` / `pyproject.toml` / `Pipfile` | Python — detect version from `python_requires`, venv/poetry/pipenv |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `pom.xml` / `build.gradle` | Java/Kotlin |
| `Gemfile` | Ruby |
| `composer.json` | PHP |
| README "Getting Started" section | NLP-assisted fallback: extract shell commands from code blocks |

**Confidence scoring:** each repo gets a confidence score (High/Medium/Low). High confidence = auto-run silently. Medium = run but show detected config for confirmation. Low = show a guided manual setup wizard instead of guessing blindly.

**Multi-service repos** (e.g., app + Postgres + Redis via docker-compose) are the highest-value, medium-difficulty case — prioritize docker-compose support early since it solves a lot of "real" repos at once.

## 7a. Interactive Resolution Engine (core differentiator)

Instead of treating a missing dependency as a failure, RepoRun treats it as a **pause point**: the build halts at the exact moment it's blocked, shows the user precisely what's needed and how to get it, and resumes the instant it's supplied. This turns most "won't work" cases into a 10-second guided step instead of a dead end.

**How it works, per obstacle type:**

| Obstacle | Auto-resolution attempt | If manual input needed |
|---|---|---|
| Missing API key / secret | Scan for `.env.example`, config schemas, or `process.env.X` / `os.environ["X"]` reads with no fallback, at build time *before* running, so gaps are known upfront rather than discovered via a crash | Modal: *"This repo needs `STRIPE_API_KEY` to run."* + a direct link to get one (curated map for common services: Stripe, OpenAI, AWS, Twilio, etc., falling back to whatever the repo's own README documents) + a field to paste it in. Process resumes automatically on submit. |
| Missing database/service (Postgres, Redis, Mongo, etc.) | Auto-provision an ephemeral instance in the sandbox with sane defaults and inject the connection string — **no user input at all** in most cases | Only surfaces to the user if the schema/seed data itself is genuinely proprietary or unavailable |
| Unusual/legacy build tooling | Use version managers pinned to repo-declared versions (`.nvmrc`, `.python-version`, `.ruby-version`); fall back to **Nix/Nixpacks** as a universal "reproduce this exact old environment" layer | Rare manual fallback: show the exact failing command + error, with a "report this stack" button to improve future detection |
| Monorepo (multiple runnable packages) | Detect `nx.json`, `lerna.json`, `turbo.json`, `pnpm-workspace.yaml`, Cargo workspaces | Simple picker: *"Which package do you want to run?"* — one click, not a wizard |
| GPU-dependent code | Detect CUDA/GPU requirement from code/deps | Offer CPU-fallback run if the code supports it; otherwise clearly flag "needs GPU — not available in this sandbox tier" rather than failing silently |
| Ambiguous entrypoint (no clear start command) | Parse README "Getting Started" code blocks via lightweight NLP | Modal asking for the one missing command, which is then cached for all future runs of that repo |

**Design principle:** every pause is (a) specific — naming the exact missing thing, not a generic error, (b) actionable — a link or a single input field, never a wall of docs, and (c) cached — once a human resolves something for a repo (a start command, a package choice), that resolution is stored and reused for every future user of that same repo, so the *community* effectively trains the detection engine over time and repos get faster to run the more people use them.

## 8. MVP Feature Set (v1)

- [ ] Chrome extension with injected "Run" button on repo pages
- [ ] Detection for: Node, Python, Go, existing Dockerfile/devcontainer/docker-compose
- [ ] Ephemeral sandboxed container execution with a public preview URL
- [ ] Embedded browser terminal for CLI-based repos
- [ ] Confidence-based UX (auto-run / confirm / manual wizard)
- [ ] Interactive Resolution Engine v1: missing-secret detection + guided input modal, auto-provisioned ephemeral DB/service containers
- [ ] Per-repo resolution caching (community-trained: one person's fix helps the next person instantly)
- [ ] Session timeout + resource caps
- [ ] Public repos only, no auth required

## 9. V2+ Roadmap
- Private repo support via GitHub OAuth
- Rust, Java, Ruby, PHP detection
- Persistent "save my environment" (paid tier)
- One-click deploy to Vercel/Fly.io/Railway after successful local run
- Firefox/Edge parity
- Team/org sharing of run configs (contributed devcontainer overrides, community-verified)
- VS Code extension counterpart (not just browser)

## 10. Success Metrics
- **Fully-automatic coverage rate**: % of visited repos that reach a *running* state with zero user input (target v1: 60–70% of top-10k GitHub repos by stars)
- **Assisted coverage rate**: % that reach a running state *including* successful resolution-engine prompts (secrets, DB provisioning, package picks) — this is the headline number, since it reflects the actual "does it work" experience (target v1: 90%+ of top-10k repos)
- **Time-to-running**: p50 and p95 seconds from click to live preview, tracked separately for fully-automatic vs. assisted runs
- **Resolution success rate**: of repos that hit a pause point, % where the user successfully supplies what's needed and the build resumes
- **Cache hit rate**: % of runs that benefit from a previous user's cached resolution (start command, package choice, etc.) — should trend upward over time as the repo library "warms up"
- **Retention**: weekly active extension users
- **Cost per session**: sandbox compute cost, since this is the main unit economics risk

## 11. Key Risks

| Risk | Mitigation |
|---|---|
| Running untrusted code = security risk | Hard sandbox isolation, no default network egress, resource/time caps, no persistent storage by default |
| Compute cost scales with usage (this is essentially "cloud IDE as a browser extension") | Aggressive session timeouts, tiered/paid plans for heavy use, cold-start caching for popular repos |
| "Doesn't work" perception if a repo fails | Never fail silently — always show *why* detection failed and what was tried |
| GitHub ToS / scraping concerns | Use GitHub's official API for metadata, respect rate limits, clone via standard git protocol like any client |
| Abuse (crypto mining, spam containers) | Rate limiting per user/IP, sandbox resource caps, abuse detection on sandbox behavior |
| User-supplied secrets (new risk from the Resolution Engine) — users now paste real API keys into the tool | Keys held in-memory only for the session, never written to disk or logs, encrypted in transit, auto-discarded on session expiry; never persisted unless the user explicitly opts into a "save my environment" feature (v2+); clearly disclose this handling in the modal itself so users aren't surprised |

## 12. Competitive Landscape
- **GitHub Codespaces / Gitpod**: excellent, but require the maintainer to define a devcontainer — most repos don't have one. RepoRun's differentiation is *automatic inference* for repos that never opted in.
- **Replit / StackBlitz / CodeSandbox**: great for specific stacks (mostly JS-heavy, or import-a-repo flows), less general-purpose stack detection across arbitrary languages.
- **Devcontainers CLI**: a good building block RepoRun could use under the hood rather than reinventing container config generation from scratch.

## 13. Open Questions for Next Iteration
- Do we host compute ourselves or let users bring their own cloud credentials (BYO-cloud) to control cost?
- How much of the "confirm detected stack" UI lives in the extension popup vs. a full webapp tab?
- What's the monetization model — freemium session limits, or pure B2B (teams evaluating vendor/OSS code)?
