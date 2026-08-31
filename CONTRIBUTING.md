# Contributing to Buddy

Thanks for helping make agentic websites more understandable and safer for people.

## Before opening a pull request

1. Create a focused branch and keep the change small enough to review.
2. Run `npm ci`, then `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`.
3. Add or update tests for behavior changes, especially permission and tool-lifecycle logic.
4. Keep API keys, local `.env` files, deployment IDs, generated builds, and user data out of commits.
5. Explain user-visible behavior and security tradeoffs in the pull request.

For vulnerabilities, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
