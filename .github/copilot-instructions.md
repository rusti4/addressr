
# Copilot Instructions for Addressr

This guide enables AI coding agents to be productive in the Addressr codebase. Follow these project-specific conventions and workflows:

## Architecture Overview
- **Service Boundaries:**
  - Main API logic is in `controllers/` (REST endpoints) and `service/` (business logic).
  - Server entry points: `server.js`, `bin/addressr-server.js`, and `src/server2.js`.
  - Data validation/search is powered by G-NAF (Geocoded National Address File).
- **ADR Management:**
  - Architectural decisions are documented in `docs/adrs/` as Markdown ADRs (MADR 2.1.2 + Log4brains patch).
  - Use Log4brains for ADR preview and authoring:
    ```bash
    npm install -g log4brains
    log4brains preview
    log4brains adr new
    ```

## Developer Workflows
- **Builds:**
  - Most code runs directly via Node.js; no standard build step.
  - Docker support: see `Dockerfile`, `scripts/`, and `deploy/` for containerization and infra automation.
- **Testing:**
  - Cucumber.js BDD tests in `test/js/` (steps, world, drivers). Example:
    ```bash
    npx cucumber-js test/js
    ```
  - K6 load tests in `test/k6/script.js`.
- **Linting:**
  - Use `lint-terraform.sh` for Terraform. JS linting is not standardized; check `package.json` for any scripts.
- **Deployment:**
  - Infrastructure as code via Terraform in `deploy/` (`main.tf`, `deploy.sh`).
  - Release automation via GitHub Actions and dagger.io (see ADRs and `.github/workflows/`).

## Patterns & Conventions
- **API Design:**
  - Swagger/OpenAPI specs in `api/` (`swagger.yaml`, `swagger-2.yaml`).
  - Controllers follow RESTful conventions (see `controllers/Addresses.js`).
- **Data Flow:**
  - Address data flows from API endpoints to service logic, validated against G-NAF.
- **External Integrations:**
  - Elasticsearch integration in `client/elasticsearch.js`.
  - Docker and Terraform for deployment.
- **ADR Format:**
  - ADRs use `YYYYMMDD-title.md` naming and support `draft` status for collaborative editing.

## Key Files & Directories
- `controllers/` – API endpoint logic
- `service/` – Business logic and utilities
- `api/` – API specifications
- `test/js/` – Cucumber.js test suites
- `docs/adrs/` – Architecture Decision Records
- `deploy/` – Infrastructure and deployment scripts
- `client/elasticsearch.js` – Elasticsearch integration

## Example: Running ADR Preview
```bash
npm install -g log4brains
log4brains preview
```

## Example: Running Cucumber.js Tests
```bash
npx cucumber-js test/js
```

---
For more details, see `README.md` and ADRs in `docs/adrs/`. Update this file as new conventions emerge.