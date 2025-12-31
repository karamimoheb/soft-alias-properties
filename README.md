# soft-alias-properties
A lightweight Obsidian plugin that syncs friendly alias properties into folder-namespaced frontmatter keys (e.g., `priority` → `projects__priority`) with optional per-folder YAML templates and cleaned-up property suggestions.

```markdown
# Namespaced Properties (Soft Aliases)

A lightweight Obsidian plugin that keeps **folder-scoped properties clean** by syncing human-friendly **alias keys** (e.g. `priority`) into **folder-namespaced storage keys** in the background (e.g. `projects__priority`).  
It also optionally applies **per-folder YAML templates** on new notes and can **hide noisy storage keys** from the property-name suggestion dropdown (notes only).

> ✅ No patching of Obsidian’s native metadata cache or property editor.  
> ✅ Works silently in the background with minimal UX change.

---

## Why this exists

When you use Bases or folder-based workflows, you often want the same “logical” property (like `priority`) to have different values per scope.  
But if you keep everything as plain `priority`, suggestions and global property value pools can get noisy over time.

This plugin solves it by storing values under a deterministic namespaced key:

- Alias key (what users type): `priority`
- Storage key (what plugin stores): `projects__priority` (or `ba__projects__priority`, depending on settings)

You can still keep your user-facing workflow the same (type `priority`), while maintaining a consistent structure for scoped data.

---

## Core behavior (sync rules)

For any note inside a configured folder rule:

1. If the note has `priority: high` and does not have a storage key yet  
   → the plugin writes `projects__priority: high`

2. If **Remove plain alias keys on sync** is enabled  
   → the plugin removes the plain `priority` key after moving it

3. If the storage key already exists  
   → storage key is treated as the source of truth (the plugin won’t overwrite it)

The plugin runs automatically on:
- active file change (open)
- file modify
- metadata cache change

---

## Features

- **Folder Rules:** map a folder prefix to a namespace slug
- **Background Sync:** automatically moves alias values into storage keys
- **Optional Cleanup:** remove the plain alias keys after syncing
- **Per-folder Templates:** auto-add YAML defaults when a new note is created
- **Dropdown Cleanup (Notes-only):** hide storage keys from property-name suggestions in note properties (keeps Bases usable)
- **Restore Tools:** bring aliases back, optionally delete storage keys (full revert)
- **Debug Logs:** detailed console logs when enabled

---

## Storage key format

Storage keys are generated like this:

```

{prefix}{namespaceSlug}{separator}{aliasKey}

```

Examples:

- prefix = `""`, separator = `__`
  - `projects__priority`
- prefix = `ba__`, separator = `__`
  - `ba__projects__priority`

---

## Settings

### Scope Rules
Each rule includes:

- **Folder prefix**  
  Example: `index/projects/`
- **Namespace slug**  
  Example: `projects`
- **Template on create (optional)**
  - Enable/disable per rule
  - YAML body (no `---` markers)

### Managed Alias Keys
Comma-separated list of alias keys that the plugin manages.

Example:
```

priority,status,owner

````

### Remove plain alias keys on sync
- **ON:** users type `priority`, plugin stores `projects__priority` and removes `priority`
- **OFF:** plugin stores both `priority` and `projects__priority` (less strict)

### Hide storage keys in suggestions (notes only)
Hides items like:
- `projects__priority`
- `ba__projects__priority`
- `anything__priority`

…but **does not hide them in Bases**, so you can still filter and select them there.

### Templates (like Templater)
When enabled, new notes created inside a rule’s folder prefix can automatically get default YAML values written into storage keys.

### Restore
- Restore aliases for the active note or all scoped notes
- Optionally delete storage keys on restore (full revert)

---

## Usage

### 1) Create a folder rule
Example rule:
- Folder prefix: `index/projects/`
- Namespace slug: `projects`

### 2) Add managed keys
Example:
`priority,status`

### 3) Add properties as usual
In a note inside `index/projects/`:

```yaml
---
priority: high
status: in progress
---
````

After sync (and if removal is enabled), the note becomes:

```yaml
---
projects__priority: high
projects__status: in progress
---
```

---

## Templates (per folder)

If you enable a template for a rule and set:

```yaml
priority: medium
status: draft
owner:
```

Then any **new** note created inside that folder can automatically receive:

```yaml
---
projects__priority: medium
projects__status: draft
projects__owner:
---
```

> If “Apply template only if note has no frontmatter” is ON, the plugin will not touch notes that already contain YAML frontmatter.

---

## Commands

* **Show Alias Inspector**
  Displays alias vs storage values for the active note (debug helper).

* **Add managed property** (optional)
  Lets you add a managed property quickly without relying on a noisy dropdown.

---

## Restore (revert to old behavior)

If you want to temporarily or permanently revert:

1. Use **Restore (active file)** or **Restore (all scoped)** from the plugin settings.
2. Optionally enable **Delete storage keys on restore** for a full revert.

---

## Notes / limitations

* This plugin is intentionally “soft”: it does not modify Obsidian’s metadata cache or native property engine.
* Storage keys are regular frontmatter keys, so they will appear in global property systems unless filtered by UI (the plugin can hide them in note property suggestions).

---

## Troubleshooting

### “It doesn’t sync”

* Make sure the note path matches at least one **Folder prefix** rule.
* Make sure the alias key is included in **Managed Alias Keys**.
* Enable **Debug logs** and check the console.

### “Storage keys disappear in Bases”

* Ensure **Hide storage keys in suggestions** is enabled only for notes (the plugin is designed to not filter Bases).
* If you customized the code, verify the “focus-gated” filter is still present.

---

