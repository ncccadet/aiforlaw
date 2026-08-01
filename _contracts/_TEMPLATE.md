# Contract: [Feature Name]
**Status:** Draft | In Progress | Done | Blocked
**Week:** Week N, Days N–N

## Ownership
| Role | Owner |
|------|-------|
| Frontend | [Name] |
| Backend | [Name] |

## Definition of Done
> One sentence: what does "complete" look like for v1?

## Daily AI Limit
- Max per student per day: **N**
- Enforced via: Redis featureLimit middleware

## Token Limits
| Direction | Max Tokens |
|-----------|------------|
| Input | N |
| Output | N |

## API Endpoints
### [METHOD] /api/[feature]/[action]
**Request:** `{ "field": "type" }`
**Response:** `{ "field": "type" }`
**Errors:** `401` not logged in | `429` limit reached | `500` server error

## File Ownership Map
| File | Owner | Done? |
|------|-------|-------|
| `frontend/src/pages/[Feature]Page.jsx` | [Name] | [ ] |
| `frontend/src/services/[feature].service.js` | [Name] | [ ] |
| `backend/routes/[feature].routes.js` | [Name] | [ ] |
| `backend/controllers/[feature].controller.js` | [Name] | [ ] |

## Database Tables Used
- List table + which columns are read/written

## Cost Calculation
N students × N calls/day × N tokens × ₹N/1K tokens = ₹N/month

## Pre-Build Checklist
- [ ] Both founders agreed on this contract
- [ ] Definition of Done is written
- [ ] Daily limit is set and agreed

## Pre-Deploy Checklist (5-Path Test)
- [ ] **Normal Path** — happy path works end to end
- [ ] **Stupid Path** — empty forms, wrong files, rapid clicks handled gracefully
- [ ] **Access Path** — cannot access another student's data by URL manipulation
- [ ] **Limit Path** — daily limit blocks at correct count with clear reset message
- [ ] **Cost Path** — API dashboard cost matches estimate after test
