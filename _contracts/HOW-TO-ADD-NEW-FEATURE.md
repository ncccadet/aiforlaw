# How to Add a New Feature — 10-Step Checklist

## Step 1 — Before Opening VS Code
- [ ] Feature is in the 30-day plan or explicitly approved
- [ ] Definition of Done written (one sentence)
- [ ] Frontend vs backend ownership agreed

## Step 2 — Create the Contract
- [ ] Copy `_TEMPLATE.md` → rename to `NN-feature-name.md`
- [ ] Fill every field
- [ ] Both founders read and agree

## Step 3 — Create Backend Files
- [ ] `backend/routes/[featureName].routes.js`
- [ ] `backend/controllers/[featureName].controller.js`
- [ ] `backend/workers/[featureName].worker.js` (if async job needed)

## Step 4 — Register Route in app.js
- [ ] Import and `app.use()` the new router
- [ ] Always wrap with `authMiddleware` inside the router

## Step 5 — Create Frontend Files
- [ ] `frontend/src/pages/[FeatureName]Page.jsx`
- [ ] `frontend/src/services/[featureName].service.js`

## Step 6 — Add to App.jsx Router
- [ ] Import page → add `<Route>` inside `<PrivateRoute>`

## Step 7 — Add to Dashboard Navigation
- [ ] Add link so students can find the feature

## Step 8 — Run Pre-Deploy Checklist (5 Paths)
- [ ] All 5 paths pass on STAGING before touching production

## Step 9 — Update Contract Status
- [ ] Draft → In Progress → Done

## Step 10 — Log the Decision
- [ ] Add one line to `_decisions/decisions-log.md`

---

## Naming Convention (non-negotiable)
| Thing | Convention | Example |
|-------|-----------|---------|
| Contract | `NN-kebab-case.md` | `09-legal-gpt.md` |
| Route file | `camelCase.routes.js` | `legalGpt.routes.js` |
| Controller | `camelCase.controller.js` | `legalGpt.controller.js` |
| Worker | `camelCase.worker.js` | `legalGpt.worker.js` |
| Page | `PascalCasePage.jsx` | `LegalGptPage.jsx` |
| Service | `camelCase.service.js` | `legalGpt.service.js` |
| API path | `/api/kebab-case` | `/api/legal-gpt` |
| Frontend route | `/kebab-case` | `/legal-gpt` |
| DB feature name | `snake_case` | `legal_gpt` |
