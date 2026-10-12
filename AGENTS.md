# AGENTS.md

Guidance for AI coding agents working in this repository.

## Code Changes

- Whenever you write or modify code, dispatch a separate subagent to perform a code review of the changes before considering the work done. Do not self-review.
- Feed the reviewer the diff (or changed files) with enough context, then fix the reported issues (or explicitly justify why a finding is a non-issue) before continuing to the next step.
- For large changes with clearly separable modules, split the work and develop with multiple subagents in parallel (one subagent per module), then integrate the results and review the combined diff.

## Pull Requests

- After submitting a pull request, always follow up on the automated review results (GitHub Copilot code review and any other review bots) before moving on to the next step.
- Address the review comments, or explicitly confirm they are non-issues, and push fixes as needed. Only proceed once the review findings are resolved.
