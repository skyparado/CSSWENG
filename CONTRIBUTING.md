# Contributing

## Branch model & protection rules

We use a simple trunk-plus-feature model.

- `main` — protected, always deployable. No direct pushes.
- `develop` — integration branch (optional; `main` is fine for the course project).
- Feature branches — `<dev>/<area>`, e.g. `sky/dev1`, `dev2/patients`, `dev4/auth`.

### Required GitHub branch protection for `main`

Set these in **Settings → Branches → Add rule** (`main`):

1. **Require a pull request before merging** (at least 1 approving review).
2. **Require status checks to pass before merging** → select the `Lint, type-check & Vitest` check from CI.
3. **Require branches to be up to date before merging.**
4. **Require conversation resolution before merging.**
5. **Do not allow bypassing the above settings** (include administrators).

> These cannot be committed as files — an admin must enable them once in the
> repository settings. CODEOWNERS (`.github/CODEOWNERS`) drives automatic
> review requests.

## Pull request flow

1. Branch off `main`: `git checkout -b <dev>/<area>`.
2. Commit small, focused changes.
3. Open a PR. CI (`.github/workflows/ci.yml`) runs Vitest, type-check and lint on every PR.
4. Get one approval, resolve comments, merge (squash).

## Data dictionary

When you add or change a Prisma model, send the updated `backend/prisma/schema.prisma`
model block to the Analyst and QA 1. The data dictionary is generated from the
real schema, not maintained separately.
