# Voxera For Law — Project Scaffold

350 Students · 8 Features · 3 Environments · 30-Day Launch

## Quick Start
1. `cd backend && cp .env.example .env` (fill real values)
2. `cd frontend && cp .env.example .env` (fill real values)
3. `cd backend && npm install && npm run dev`
4. `cd frontend && npm install && npm run dev`

## Stack
React + Vite · Node/Express · PostgreSQL + pgvector · Redis + BullMQ · AWS ap-south-1

| Environment | Machine       | Purpose              |
|-------------|---------------|----------------------|
| Local       | Your laptop   | Build & break freely |
| Staging     | EC2 t3.micro  | Mirror of production |
| Production  | EC2 t3.small  | Real 350 students    |
