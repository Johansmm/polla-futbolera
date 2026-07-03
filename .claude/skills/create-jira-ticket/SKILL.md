# Create Jira Ticket

This skill creates a Jira issue using the standard ticket format observed in the G3 project,
adaptable to any epic or project.

## Trigger

Use this skill when the user wants to create a Jira ticket, story, bug, task, or subtask.
Examples: "crea un ticket en jira", "create a story for X", "abre un bug para Y",
or simply `/create-jira-ticket`.

---

## Standard ticket format

### Story / Task

```
**Description**

<Short paragraph: context and what needs to be done.>

**Goal**

<One paragraph: what this achieves and why it matters.>

**Scope**

* <In-scope item 1>
* <In-scope item 2>

**Out of scope**

* <Out-of-scope item 1>

**Acceptance Criteria**

* <Verifiable criterion 1>
* <Verifiable criterion 2>

**References**

* Stack: <technologies involved>
* <Any relevant links or related tickets>
```

### Bug

```
<Context paragraph: what is broken and where it was observed.>

---

**Bug — <Short bug title>**

<Detailed description of the problem.>

---

**Scope**

* <What to investigate or fix>

**Out of scope**

* <What not to touch>

**Acceptance Criteria**

* <How to verify the bug is fixed>

**References**

* Stack: <technologies involved>
```

### Sub-task

Sub-tasks follow the Story/Task format but are shorter. They must always have a parent.

---

## Steps

### 1. Gather information

Ask the user (grouping all questions in a single message) for anything not already clear
from context:

1. **Project key** — e.g. `G3`. If the user mentioned a project or epic, infer it.
2. **Issue type** — Story, Task, Bug, or Sub-task.
3. **Summary** — one-line title (the component prefix from step 1.5 will be prepended automatically).
4. **Description intent** — what the ticket is about (a few sentences; the skill expands
   it into the standard format).
5. **Parent issue** — required for Sub-task, optional for others (e.g. `G3-5`).
6. **Assignee** — a name or account. Leave blank to create the ticket unassigned.

If the user already provided enough context, skip fields that are already clear.

### 1.5. Infer component prefix from parent issue

If a parent issue was provided (e.g. `G3-1`):

1. Use `getJiraIssue` to fetch the parent issue.
2. Use `searchJiraIssuesUsingJql` with JQL `parent = <parent-key> ORDER BY created ASC` to list
   the parent's existing children (limit to 20).
3. Scan the children's summaries for a `[SomeName]` prefix pattern (e.g. `[Optimizer]`,
   `[Compiler]`). If the majority share the same prefix, that is the **component prefix** for
   this ticket.
4. If the parent's own summary starts with a `[SomeName]` prefix and no children exist yet,
   use that prefix.
5. If no consistent prefix is found, do **not** invent one — leave the summary without a prefix.

Prepend the inferred component prefix to the summary before drafting or showing it to the user.
For example, if the prefix is `[Optimizer]` and the user's title is `sanitize: fold aten.eye`,
the final summary becomes `[Optimizer] sanitize: fold aten.eye`.

### 2. Draft the description

Using the information provided, write a full description following the standard format
for the chosen issue type:

- Fill in all sections: **Description**, **Goal**, **Scope**, **Out of scope**,
  **Acceptance Criteria**, **References**
- For Sub-tasks, a shorter format is acceptable: **Goal**, a bullet list of tasks,
  and **Acceptance Criteria**
- Keep the language consistent with the rest of the project (English, technical,
  imperative for scope/criteria)
- Show the drafted description to the user and ask for confirmation or changes
  **before creating the ticket**

### 3. Resolve assignee account ID (only if provided)

- If the user specified an assignee by name, use `lookupJiraAccountId` to resolve the
  account ID.
- If the user left the assignee blank, do **not** set an assignee — leave it unassigned.

### 4. Create the ticket

Call `createJiraIssue` with:

- `cloudId`: `be03f0f8-d6fc-48ec-b745-01c4b638fb53`
- `projectKey`: as provided by the user
- `issueTypeName`: one of `Story`, `Task`, `Bug`, `Sub-task`
- `summary`: the final summary
- `description`: the confirmed description in ADF format (see Important rules)
- `contentFormat`: `adf`
- `parent`: parent issue key (if Sub-task or if the user provided one)
- `assignee_account_id`: only include if an assignee was explicitly provided

### 5. Report result

Print:
- The created issue key (e.g. `G3-150`)
- The summary
- A link: `https://brainchip.atlassian.net/browse/<key>`

---

## Important rules

- **Always show the drafted description to the user before creating the ticket.**
  Never create it without confirmation.
- **Always infer the component prefix from the parent issue's children** (step 1.5) when a parent
  is given. Never omit the prefix if it is consistent across the sibling tickets, and never invent
  one if it is not present.
- Never guess the parent issue — ask if unsure.
- Use `Sub-task` (with hyphen) as the issue type name, not `Subtask`.
- If assignee is blank, omit the `assignee_account_id` field entirely — do not default
  to the current user.
- **Do not insert artificial line breaks within paragraphs.** Write each paragraph as a single continuous line. Only use `\n` to separate sections or list items — never to wrap text at a character limit.
- **Always use `contentFormat: adf` for descriptions and comments.** Plain text issue keys (e.g. `G3-302`) and markdown links do **not** render as Jira chips — Jira does not auto-link issue keys in descriptions or comments. The entire body must be expressed as an ADF document (`{"type": "doc", "version": 1, "content": [...]}`), with bold as `strong` marks, inline code as `code` marks, and issue references as `inlineCard` nodes:
  ```json
  {
    "type": "inlineCard",
    "attrs": { "url": "https://brainchip.atlassian.net/browse/G3-302" }
  }
  ```
