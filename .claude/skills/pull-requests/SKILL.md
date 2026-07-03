---
name: pull-request
description: Guide for creating well-structured pull requests. Use when opening a PR, drafting a PR title or description, or reviewing PR quality before requesting review.
---

# Pull Request Guide

This skill ensures pull requests follow team conventions for title, description, scope, and
readiness before review is requested.

---

## Before Opening a PR

Verify all of the following before opening:

- [ ] All tests pass, including style and lint checks
- [ ] Self-review completed — read your own diff before requesting others
- [ ] No more than **10 commits** on the branch
- [ ] Fewer than **1000 changed lines** — if exceeded, split the feature into smaller PRs
- [ ] Branch targets the correct base (`main` or an integration branch)

---

## PR Title

```
G3-123 Short description of the change
```

- Starts with the **Jira ticket ID**
- Followed by a concise description in command tense ("Add feature", not "Added feature")
- No period at the end

**Good examples:**
- `G3-42 Add OAuth login support`
- `G3-101 Fix race condition in scheduler`

**Bad examples:**
- `Fix bug` (no ticket, no context)
- `G3-42 Added OAuth login support` (wrong tense)
- `G3-42 Add OAuth login support and fix token refresh and update tests` (not atomic)

---

## PR Description

### Standard PR (targeting `main`)

The description must include the following sections when relevant:

**Overview**
What this PR does and why. One short paragraph is enough.

**Summary of changes**
Key changes made. Focus on what changed, not how (the diff shows the how).

**Notes for reviewers** *(when relevant)*
Anything that warrants attention: known trade-offs, areas of uncertainty, decisions made,
or things that look odd but are intentional.

**Jira ticket**
A direct link to the corresponding Jira ticket.
Format: `https://brainchip.atlassian.net/browse/G3-123`

### Ticket reference restriction

The description must **not** explicitly mention any Jira ticket ID other than the one the PR targets. Context and motivation that relate to other tickets are allowed, but do not write the ticket ID (e.g. `G3-4`, `G3-7`) anywhere in the description body.

**Allowed** — describing context without naming another ticket:
> "This change avoids a re-entry issue that was observed during load testing."

**Not allowed** — explicitly referencing another ticket ID:
> "This change also fixes G3-7."
> "Related to G3-4."

### Integration Branch PR

When a PR targets an integration branch instead of `main`, the description must:

1. **Explicitly state** that this PR targets an integration branch, not `main`.
2. **Include a checklist** of all PRs in the integration sequence, marking completed and
   current ones.

**Example:**

```
> ⚠️ This PR targets the integration branch `integration/G3-58`, not `main`.

## Integration progress

- [x] G3-58 First piece
- [x] G3-58 Second piece  ← current PR
- [ ] G3-58 Third piece
```

---

## Assignee, Reviewers, and Labels

### Assignee

Always assign the PR to its creator using `--assignee @me`. The `@me` alias resolves to
the currently authenticated GitHub CLI user — no need to look up the username manually.

### Labels

Suggest a label that matches the nature of the change. Common labels:

| Change type | Label |
|---|---|
| New feature | `enhancement` |
| Bug fix | `bug` |
| Documentation | `documentation` |
| CI/CD change | `ci` |
| Refactor | `refactor` |
| Dependency update | `dependencies` |

Add with `--label <label>`. If the label does not exist in the repo, omit it and note
it to the user rather than failing the command.

---

## Review & Merge

- A minimum of **2 approvals** is required before merging.
- **Codeowner review is mandatory** (enforced by GitHub).
- Anyone with the required approvals can merge.
- Delete the branch after merging (feature and integration branches).

---

## Pre-PR Checklist

- [ ] Tests pass including style/lint checks
- [ ] Self-review done
- [ ] 10 commits or fewer on the branch
- [ ] Fewer than 1000 changed lines
- [ ] Branch has been pushed and exists on the remote (`git push -u origin HEAD` if not)
- [ ] PR title starts with Jira ticket ID and uses command tense
- [ ] Description includes overview, summary of changes, and Jira link
- [ ] Notes for reviewers added if anything warrants attention
- [ ] Description contains no Jira ticket IDs other than the PR's own ticket
- [ ] Integration branch target explicitly stated if not targeting `main`
- [ ] `--assignee @me` included in the `gh pr create` command
- [ ] Label selected to match the type of change

---

## When Creating a PR

1. **Draft the title** — Jira ticket ID + concise command-tense description.
2. **Draft the description** — overview, changes, notes, Jira link. Do not insert artificial line breaks within paragraphs; write each paragraph as a single continuous line.
3. **Flag integration target** — if targeting an integration branch, add the notice and
   progress checklist.
4. **Resolve assignee and label** — always use `--assignee @me`; pick a label from the table above.
5. **Check branch sync** — run `git status -sb` to compare local vs remote:
   - **In sync** (`[ahead 0, behind 0]` or no divergence indicator): show the full PR draft to the user and **propose running `gh pr create`**. Wait for explicit confirmation before executing.
   - **Not in sync** (local ahead, behind, or diverged): show the PR description only — do not propose or run `gh pr create`. Inform the user that the branch must be synced first.

```bash
gh pr create \
  --title "G3-123 Add feature" \
  --assignee @me \
  --label <label> \
  --body "$(cat <<'EOF'
## Overview
...

## Summary of changes
...

## Jira ticket
https://brainchip.atlassian.net/browse/G3-123
EOF
)"
```
