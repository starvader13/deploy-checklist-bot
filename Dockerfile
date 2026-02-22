# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Full Node environment with devDependencies to compile T   ypeScript → JavaScript.
# Nothing from this stage ships in the final image except the compiled dist/.
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first — separate layer so Docker can cache node_modules
# and skip reinstalling dependencies when only source files change.
COPY package*.json ./
RUN npm ci

# Now copy source and compile. This layer changes on every code change,
# which is fine — it's near the bottom of the cache stack.
COPY . .
RUN npm run build


# ── Stage 2: Run ─────────────────────────────────────────────────────────────
# Lean production image — only compiled output and production dependencies.
# No TypeScript compiler, no test runner, no devDependencies.
FROM node:20-alpine AS runner

WORKDIR /app

# Tell Node.js and libraries to use production mode (optimizations, less logging).
ENV NODE_ENV=production

# Create a non-root user to run the process.
# Containers default to root — this limits the blast radius if the app is compromised.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Install only production dependencies — skips everything in devDependencies.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript from the builder stage.
# This is the only thing we take from stage 1.
COPY --from=builder /app/dist ./dist

# Drop root privileges before starting the process.
USER appuser

# Document that the app listens on port 8080.
# Actual port binding happens at runtime: docker run -p 8080:3000
EXPOSE 8080

# Start Probot with the compiled entry point.
CMD ["node_modules/.bin/probot", "run", "./dist/index.js"]
