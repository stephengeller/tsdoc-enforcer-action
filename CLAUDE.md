# Repo conventions for Claude

## Actions in this repo must be generic

Every action, workflow, and example in this repo must be **domain-neutral and
reusable**. The user may describe a task in terms of a specific organisation,
product, or domain, but that context is for _motivation only_ — it must not
leak into the shipped code or docs.

Concretely:

- **No hardcoded org names, team handles, repo names, user logins, or
  domain-specific terminology** in `action.yml` inputs, defaults, descriptions,
  env vars, branch prefixes, commit/PR templates, or example workflows.
- **No domain-specific defaults.** If an input only makes sense with a
  specific value in the user's context, make the input required (no default)
  rather than baking the specific value in.
- **READMEs use generic framing.** A concrete domain example is fine as one
  recipe among several, but it must not be the primary or only framing.
- **Commit messages and PR descriptions follow the same rule** — future
  readers of this public repo shouldn't be able to reverse-engineer which
  company or product prompted the work.

If the user's prompt mentions a specific domain, translate it to a generic
concept before implementing. Keep the abstraction in your response too — it's
fine to acknowledge the concrete use case, but the code and docs stay generic.
