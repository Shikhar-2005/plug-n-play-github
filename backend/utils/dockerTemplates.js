/**
 * Docker Templates — base Dockerfile templates for each supported stack.
 * Each template is a function that takes detection results and returns
 * a Dockerfile string.
 */

const templates = {
  // ── Node.js ──
  node: (detection) => {
    const nodeVersion = parseNodeVersion(detection.version) || '20';
    const pm = detection.packageManager || 'npm';

    const installCmd = {
      npm: 'npm ci --omit=dev',
      yarn: 'yarn install --frozen-lockfile --production',
      pnpm: 'pnpm install --frozen-lockfile --prod',
      bun: 'bun install --production',
    }[pm] || 'npm ci --omit=dev';

    const installDevCmd = {
      npm: 'npm ci',
      yarn: 'yarn install --frozen-lockfile',
      pnpm: 'pnpm install --frozen-lockfile',
      bun: 'bun install',
    }[pm] || 'npm ci';

    // Use dev install for dev servers that need devDependencies
    const isDevServer = detection.startCommand && (
      detection.startCommand.includes('dev') ||
      detection.startCommand.includes('next dev') ||
      detection.startCommand.includes('vite')
    );

    const copyLockfile = {
      npm: 'COPY package-lock.json* ./',
      yarn: 'COPY yarn.lock* ./',
      pnpm: 'COPY pnpm-lock.yaml* ./',
      bun: 'COPY bun.lockb* bun.lock* ./',
    }[pm] || '';

    const pnpmSetup = pm === 'pnpm' ? 'RUN corepack enable && corepack prepare pnpm@latest --activate\n' : '';
    const bunSetup = pm === 'bun' ? `
# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:\${PATH}"
` : '';

    const startCmd = detection.startCommand || `${pm} start`;

    return `FROM node:${nodeVersion}-slim

WORKDIR /app

${bunSetup}${pnpmSetup}# Copy package manifests for better layer caching
COPY package.json ./
${copyLockfile}

# Install dependencies
RUN ${isDevServer ? installDevCmd : installCmd}

# Copy source code
COPY . .

# Expose common ports
EXPOSE 3000 5173 8080 4200

# Start the app
CMD ${JSON.stringify(startCmd.split(' '))}
`;
  },

  // ── Python ──
  python: (detection) => {
    const pyVersion = detection.version || '3.12';
    const pm = detection.packageManager || 'pip';
    const startCmd = detection.startCommand || 'python main.py';

    let installBlock = '';
    if (pm === 'poetry') {
      installBlock = `# Install Poetry
RUN pip install poetry
COPY pyproject.toml poetry.lock* ./
RUN poetry config virtualenvs.create false && poetry install --no-dev --no-interaction`;
    } else if (pm === 'pipenv') {
      installBlock = `# Install Pipenv
RUN pip install pipenv
COPY Pipfile Pipfile.lock* ./
RUN pipenv install --system --deploy`;
    } else {
      installBlock = `# Install dependencies
COPY requirements.txt* ./
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || true

# Also try pyproject.toml
COPY pyproject.toml* ./
RUN pip install --no-cache-dir . 2>/dev/null || true`;
    }

    return `FROM python:${pyVersion}-slim

WORKDIR /app

# Install system dependencies commonly needed
RUN apt-get update && apt-get install -y --no-install-recommends \\
    gcc libpq-dev && \\
    rm -rf /var/lib/apt/lists/*

${installBlock}

# Copy source code
COPY . .

# Expose common ports
EXPOSE 8000 5000 8501

# Start the app
CMD ${JSON.stringify(startCmd.split(' '))}
`;
  },

  // ── Go ──
  go: (detection) => {
    const goVersion = detection.version || '1.22';
    const startCmd = detection.startCommand || 'go run .';
    const isRun = startCmd.startsWith('go run');

    if (isRun) {
      // Development mode — run directly
      return `FROM golang:${goVersion}

WORKDIR /app

# Copy go module files for caching
COPY go.mod go.sum* ./
RUN go mod download

# Copy source code
COPY . .

EXPOSE 8080 3000

CMD ${JSON.stringify(startCmd.split(' '))}
`;
    }

    // Production build
    return `FROM golang:${goVersion} AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/server .

EXPOSE 8080 3000

CMD ["./server"]
`;
  },

  // ── Rust ──
  rust: (_detection) => {
    return `FROM rust:1.79-slim

WORKDIR /app

# Copy manifests
COPY Cargo.toml Cargo.lock* ./

# Create a dummy main.rs for dependency caching
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release 2>/dev/null || true
RUN rm -rf src

# Copy real source
COPY . .
RUN cargo build --release

EXPOSE 8080 3000

CMD ["./target/release/$(basename $(pwd))"]
`;
  },

  // ── Java (Maven) ──
  java_maven: (_detection) => {
    return `FROM maven:3.9-eclipse-temurin-21

WORKDIR /app

COPY pom.xml ./
RUN mvn dependency:resolve

COPY . .

EXPOSE 8080

CMD ["mvn", "spring-boot:run"]
`;
  },

  // ── Java (Gradle) ──
  java_gradle: (_detection) => {
    return `FROM gradle:8-jdk21

WORKDIR /app

COPY build.gradle* settings.gradle* gradlew* ./
COPY gradle/ gradle/ 2>/dev/null || true
RUN gradle dependencies --no-daemon 2>/dev/null || true

COPY . .
RUN chmod +x gradlew 2>/dev/null || true

EXPOSE 8080

CMD ["./gradlew", "bootRun"]
`;
  },

  // ── Ruby ──
  ruby: (_detection) => {
    return `FROM ruby:3.3-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential libpq-dev nodejs && \\
    rm -rf /var/lib/apt/lists/*

COPY Gemfile Gemfile.lock* ./
RUN bundle install

COPY . .

EXPOSE 3000

CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
`;
  },

  // ── PHP ──
  php: (_detection) => {
    return `FROM php:8.3-cli

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \\
    git unzip && \\
    rm -rf /var/lib/apt/lists/*

COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

COPY composer.json composer.lock* ./
RUN composer install --no-dev --no-scripts

COPY . .

EXPOSE 8000

CMD ["php", "-S", "0.0.0.0:8000", "-t", "public"]
`;
  },
};

/**
 * Parse a node version string (e.g. ">=18", "18.x", "^20.0.0") into a major version number.
 */
function parseNodeVersion(versionStr) {
  if (!versionStr) return null;
  const match = versionStr.match(/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Docker Compose template for ephemeral service containers.
 */
function serviceCompose(services, appConfig = {}) {
  const serviceBlocks = {};

  if (services.includes('postgres')) {
    serviceBlocks.postgres = {
      image: 'postgres:16-alpine',
      environment: {
        POSTGRES_USER: 'reporun',
        POSTGRES_PASSWORD: 'reporun',
        POSTGRES_DB: 'app',
      },
      ports: ['5432:5432'],
      tmpfs: ['/var/lib/postgresql/data'], // Ephemeral — no persistent storage
    };
  }

  if (services.includes('redis')) {
    serviceBlocks.redis = {
      image: 'redis:7-alpine',
      ports: ['6379:6379'],
    };
  }

  if (services.includes('mongodb')) {
    serviceBlocks.mongodb = {
      image: 'mongo:7',
      ports: ['27017:27017'],
      tmpfs: ['/data/db'],
    };
  }

  if (services.includes('mysql')) {
    serviceBlocks.mysql = {
      image: 'mysql:8',
      environment: {
        MYSQL_ROOT_PASSWORD: 'reporun',
        MYSQL_DATABASE: 'app',
        MYSQL_USER: 'reporun',
        MYSQL_PASSWORD: 'reporun',
      },
      ports: ['3306:3306'],
      tmpfs: ['/var/lib/mysql'],
    };
  }

  if (services.includes('rabbitmq')) {
    serviceBlocks.rabbitmq = {
      image: 'rabbitmq:3-management-alpine',
      ports: ['5672:5672', '15672:15672'],
    };
  }

  return serviceBlocks;
}

/**
 * Generate environment variables for auto-provisioned services.
 */
function serviceEnvVars(services) {
  const env = {};

  if (services.includes('postgres')) {
    env.DATABASE_URL = 'postgresql://reporun:reporun@postgres:5432/app';
    env.POSTGRES_HOST = 'postgres';
    env.POSTGRES_PORT = '5432';
    env.POSTGRES_USER = 'reporun';
    env.POSTGRES_PASSWORD = 'reporun';
    env.POSTGRES_DB = 'app';
    env.PGHOST = 'postgres';
    env.PGPORT = '5432';
    env.PGUSER = 'reporun';
    env.PGPASSWORD = 'reporun';
    env.PGDATABASE = 'app';
  }

  if (services.includes('redis')) {
    env.REDIS_URL = 'redis://redis:6379';
    env.REDIS_HOST = 'redis';
    env.REDIS_PORT = '6379';
  }

  if (services.includes('mongodb')) {
    env.MONGODB_URI = 'mongodb://mongodb:27017/app';
    env.MONGO_URI = 'mongodb://mongodb:27017/app';
    env.MONGO_URL = 'mongodb://mongodb:27017/app';
  }

  if (services.includes('mysql')) {
    env.MYSQL_HOST = 'mysql';
    env.MYSQL_PORT = '3306';
    env.MYSQL_USER = 'reporun';
    env.MYSQL_PASSWORD = 'reporun';
    env.MYSQL_DATABASE = 'app';
    env.DATABASE_URL = 'mysql://reporun:reporun@mysql:3306/app';
  }

  return env;
}

module.exports = { templates, serviceCompose, serviceEnvVars, parseNodeVersion };
