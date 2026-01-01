import {
  App,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFolder,
  AbstractInputSuggest,
  TFile,
  WorkspaceLeaf,
  parseYaml,
  setIcon,
} from "obsidian";

/** ---------- Types ---------- */

type SyncReason = "open" | "modify" | "metadata-changed" | "manual";

interface FolderRule {
  folderPrefix: string; // e.g. "index/projects/"
  namespaceSlug: string; // e.g. "projects"

  // Template (per rule)
  templateEnabled?: boolean;
  templateYaml?: string; // YAML lines WITHOUT --- markers
}

interface SoftAliasSettings {
  folderRules: FolderRule[];

  managedAliasKeys: string; // comma-separated
  removePlainAliasKeysOnSync: boolean;

  storagePrefix: string; // "" or "ba__"
  storageSeparator: string; // "__" or "_"

  // Restore behavior
  deleteStorageKeysOnRestore: boolean;

  // UX helpers
  hideStorageKeysInPropertyNameSuggest: boolean;
  enableQuickAddManagedProperty: boolean;

  // Template features
  enableAutoTemplateOnCreate: boolean;
  applyTemplateOnlyIfNoFrontmatter: boolean;

  debounceMs: number;
  debugLogs: boolean;

  // legacy migration
  folderRulesJson?: string;
}

const DEFAULT_SETTINGS: SoftAliasSettings = {
  folderRules: [],

  managedAliasKeys: "priority,status,owner",
  removePlainAliasKeysOnSync: true,

  storagePrefix: "",
  storageSeparator: "__",

  deleteStorageKeysOnRestore: false,

  hideStorageKeysInPropertyNameSuggest: true,
  enableQuickAddManagedProperty: true,

  enableAutoTemplateOnCreate: true,
  applyTemplateOnlyIfNoFrontmatter: true,

  debounceMs: 300,
  debugLogs: true,
};

/** ---------- Helpers ---------- */

function normalizePrefix(prefix: string): string {
  const p = (prefix || "").trim();
  if (!p) return "";
  const normalized = p.replace(/\\/g, "/");
  return normalized.endsWith("/") ? normalized : normalized + "/";
}

function parseManagedKeys(raw: string): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function stringify(v: any): string {
  if (v === undefined) return "(missing)";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function safeJsonParseLegacyRules(raw: string): { rules: FolderRule[]; error?: string } {
  const text = (raw || "").trim();
  if (!text) return { rules: [] };

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { rules: [], error: "Folder Rules JSON must be an array." };

    const rules: FolderRule[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const folderPrefix = typeof (item as any).folderPrefix === "string" ? (item as any).folderPrefix : "";
      const namespaceSlug = typeof (item as any).namespaceSlug === "string" ? (item as any).namespaceSlug : "";
      if (!folderPrefix.trim() || !namespaceSlug.trim()) continue;

      rules.push({
        folderPrefix: normalizePrefix(folderPrefix),
        namespaceSlug: namespaceSlug.trim(),
        templateEnabled: false,
        templateYaml: "",
      });
    }
    return { rules };
  } catch {
    return { rules: [], error: "Invalid legacy Folder Rules JSON." };
  }
}

/** ---------- Modals ---------- */

class AliasInspectorModal extends Modal {
  private plugin: SoftAliasNamespacedProperties;

  constructor(app: App, plugin: SoftAliasNamespacedProperties) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Soft Alias Inspector" });

    const file = this.plugin.getActiveMarkdownFile();
    if (!file) {
      contentEl.createEl("div", { text: "No active markdown file." });
      return;
    }

    const slug = this.plugin.getNamespaceSlugForFile(file);
    contentEl.createEl("div", { text: `File: ${file.path}` });
    contentEl.createEl("div", { text: `Matched slug: ${slug ?? "(none)"}` });

    const keys = this.plugin.getManagedAliasKeys();
    contentEl.createEl("div", { text: `Managed keys: ${keys.join(", ") || "(none)"}` });

    const cache = this.app.metadataCache.getFileCache(file);
    const fm: Record<string, any> = (cache?.frontmatter as any) ?? {};

    const table = contentEl.createEl("table");
    table.style.width = "100%";
    table.style.marginTop = "12px";
    table.style.borderCollapse = "collapse";

    const head = table.createEl("tr");
    ["Alias", "Storage Key", "Alias Value", "Storage Value"].forEach((h) => {
      const th = head.createEl("th", { text: h });
      th.style.textAlign = "left";
      th.style.padding = "6px";
      th.style.borderBottom = "1px solid var(--background-modifier-border)";
    });

    for (const alias of keys) {
      const storage = slug ? this.plugin.makeStorageKey(slug, alias) : "(no scope)";
      const tr = table.createEl("tr");

      const aliasVal = Object.prototype.hasOwnProperty.call(fm, alias) ? fm[alias] : undefined;
      const storageVal =
        slug && Object.prototype.hasOwnProperty.call(fm, storage) ? fm[storage] : undefined;

      [alias, storage, stringify(aliasVal), stringify(storageVal)].forEach((v) => {
        const td = tr.createEl("td", { text: v });
        td.style.padding = "6px";
        td.style.borderBottom = "1px solid var(--background-modifier-border)";
        td.style.verticalAlign = "top";
      });
    }

    const note = contentEl.createEl("div", {
      text: "Note: (missing) means that key does not exist in the note's frontmatter.",
    });
    note.style.opacity = "0.75";
    note.style.marginTop = "10px";
  }
}

class ManagedPropertyPickerModal extends Modal {
  private plugin: SoftAliasNamespacedProperties;
  private onPick: (key: string) => void;

  constructor(app: App, plugin: SoftAliasNamespacedProperties, onPick: (key: string) => void) {
    super(app);
    this.plugin = plugin;
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Add managed property" });

    const keys = this.plugin.getManagedAliasKeys();
    if (keys.length === 0) {
      contentEl.createEl("div", { text: "No managed keys configured." });
      return;
    }

    const list = contentEl.createEl("div");
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "8px";
    list.style.marginTop = "10px";

    for (const k of keys) {
      const btn = list.createEl("button", { text: k });
      btn.style.textAlign = "left";
      btn.onclick = () => {
        this.onPick(k);
        this.close();
      };
    }
  }
}

/** ---------- Settings UI (Modern + Accordion + Live filter) ---------- */

/** ---------- Folder path suggest (Settings) ---------- */

class FolderPrefixSuggest extends AbstractInputSuggest<TFolder> {
  private inputElRef: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputElRef = inputEl;
  }

  getSuggestions(inputStr: string): TFolder[] {
    const q = (inputStr || "").trim().toLowerCase();

    const all = this.app.vault.getAllLoadedFiles();
    const folders = all.filter((f): f is TFolder => f instanceof TFolder);

    const filtered = q
      ? folders.filter((f) => f.path.toLowerCase().includes(q))
      : folders;

    // exclude .obsidian
    const cleaned = filtered.filter((f) => !f.path.startsWith(".obsidian"));

    cleaned.sort((a, b) => (a.path.length - b.path.length) || a.path.localeCompare(b.path));

    return cleaned.slice(0, 60);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path.endsWith("/") ? folder.path : folder.path + "/");
  }

  selectSuggestion(folder: TFolder): void {
    const val = folder.path.endsWith("/") ? folder.path : folder.path + "/";
    this.inputElRef.value = val;

    // Trigger input + change so Settings handlers pick up the value
    this.inputElRef.dispatchEvent(new Event("input", { bubbles: true }));
    this.inputElRef.dispatchEvent(new Event("change", { bubbles: true }));

    this.close();
  }
}

class SoftAliasSettingTab extends PluginSettingTab {
  private plugin: SoftAliasNamespacedProperties;

  // Live filter text (kept across re-render)
  private ruleFilter: string = "";

  constructor(app: App, plugin: SoftAliasNamespacedProperties) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private injectSettingsStyles(containerEl: HTMLElement) {
    if (containerEl.querySelector("style[data-softalias-ui]")) return;

    const style = containerEl.createEl("style");
    style.setAttribute("data-softalias-ui", "1");
    style.textContent = `
      .softalias-wrap { display: flex; flex-direction: column; gap: 16px; }

      /* Top-level accordion */
      .softalias-section {
        border: 1px solid var(--background-modifier-border);
        border-radius: 14px;
        overflow: hidden;
        background: var(--background-primary);
      }
      .softalias-section + .softalias-section { margin-top: 10px; }
      .softalias-section-header {
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        padding: 12px 12px;
        cursor:pointer; user-select:none;
      }
      .softalias-section-title { display:flex; flex-direction:column; gap:2px; min-width:0; }
      .softalias-section-title strong {
        font-size: 14px; line-height: 1.2;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .softalias-section-title .sub {
        font-size: 12px; opacity: 0.75;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .softalias-section-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
      .softalias-section-body { display:none; padding: 10px 12px 12px 12px; }
      .softalias-section[data-open="1"] .softalias-section-body { display:block; }

      /* Icons */
      .softalias-iconbtn.clickable-icon {
        width: 30px; height: 30px;
        border-radius: 10px;
        display:flex; align-items:center; justify-content:center;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-secondary);
      }
      .softalias-iconbtn.clickable-icon:hover {
        background: var(--background-secondary-alt);
      }

      /* Rule list accordion */
      .softalias-accordion {
        border: 1px solid var(--background-modifier-border);
        border-radius: 12px;
        overflow: hidden;
        background: var(--background-primary);
      }
      .softalias-acc-item + .softalias-acc-item {
        border-top: 1px solid var(--background-modifier-border);
      }
      .softalias-acc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        cursor: pointer;
        user-select: none;
      }
      .softalias-acc-title {
        display:flex; flex-direction:column; gap:2px; min-width:0;
      }
      .softalias-acc-title strong {
        font-size: 13px; line-height: 1.2;
        white-space: nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .softalias-acc-sub {
        font-size: 12px; opacity: 0.7;
        white-space: nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .softalias-acc-actions { display:flex; align-items:center; gap:6px; flex-shrink:0; }
      .softalias-acc-body { padding: 10px 12px 12px 12px; display:none; }
      .softalias-acc-item[data-open="1"] .softalias-acc-body { display:block; }

      .softalias-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      @media (max-width: 720px) { .softalias-grid { grid-template-columns: 1fr; } }

      .softalias-textarea {
        width: 100%;
        box-sizing: border-box;
        resize: none;
        max-width: 100%;
        min-height: 120px;
        line-height: 1.4;
        font-family: var(--font-monospace);
        font-size: 12px;
        border-radius: 10px;
        padding: 10px;
        overflow: auto;
      }

      .softalias-btn-row {
        display:flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items:center;
      }

      .softalias-muted { opacity: 0.75; font-size: 12px; }
      .softalias-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      .softalias-input { flex: 1; min-width: 160px; }

      /* Prevent settings controls from blowing layout */
      .setting-item-control input,
      .setting-item-control textarea {
        max-width: 100%;
        box-sizing: border-box;
      }
    `;
  }

  private iconButton(parent: HTMLElement, icon: string, tooltip: string, onClick: () => void) {
    const btn = parent.createEl("button");
    btn.classList.add("clickable-icon", "softalias-iconbtn");
    btn.setAttribute("aria-label", tooltip);
    btn.title = tooltip;

    try {
      setIcon(btn, icon);
    } catch {
      // if icon name doesn't exist in a build, fallback (still clickable)
      btn.textContent = "•";
    }

    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    };
    return btn;
  }

  private makeSection(container: HTMLElement, title: string, subtitle: string, startOpen: boolean) {
    const sec = container.createEl("div", { cls: "softalias-section" });
    sec.setAttribute("data-open", startOpen ? "1" : "0");

    const header = sec.createEl("div", { cls: "softalias-section-header" });

    const left = header.createEl("div", { cls: "softalias-section-title" });
    left.createEl("strong", { text: title });
    left.createEl("div", { cls: "sub", text: subtitle });

    const actions = header.createEl("div", { cls: "softalias-section-actions" });
    this.iconButton(actions, "chevron-down", "Toggle section", () => {
      /* header click toggles; this is just a visual affordance */
    });

    const body = sec.createEl("div", { cls: "softalias-section-body" });

    header.onclick = () => {
      const open = sec.getAttribute("data-open") === "1";
      sec.setAttribute("data-open", open ? "0" : "1");
    };

    return { sec, body, actions };
  }

  private makeRuleAccordionItem(
    acc: HTMLElement,
    title: string,
    subtitle: string,
    startOpen: boolean
  ) {
    const item = acc.createEl("div", { cls: "softalias-acc-item" });
    item.setAttribute("data-open", startOpen ? "1" : "0");

    const header = item.createEl("div", { cls: "softalias-acc-header" });

    const left = header.createEl("div", { cls: "softalias-acc-title" });
    const titleEl = left.createEl("strong", { text: title });
    const subEl = left.createEl("div", { cls: "softalias-acc-sub", text: subtitle });

    const actions = header.createEl("div", { cls: "softalias-acc-actions" });
    const body = item.createEl("div", { cls: "softalias-acc-body" });

    header.onclick = () => {
      const open = item.getAttribute("data-open") === "1";
      item.setAttribute("data-open", open ? "0" : "1");
    };

    return { item, header, actions, body, titleEl, subEl };
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.injectSettingsStyles(containerEl);

    containerEl.createEl("h2", { text: "Soft Alias Namespaced Properties" });

    const wrap = containerEl.createEl("div", { cls: "softalias-wrap" });

    /** -------- Section: Scope Rules -------- */
    const scope = this.makeSection(
      wrap,
      "Scope Rules",
      `Rules: ${this.plugin.settings.folderRules.length}`,
      true
    );

    // Live filter (NO re-render; avoid mobile keyboard closing)
    const filterRow = scope.body.createEl("div", { cls: "softalias-row" });
    const filterInputWrap = filterRow.createEl("div", { cls: "softalias-input" });

    const ruleItems: HTMLElement[] = [];

    const applyRuleFilter = () => {
      const q = (this.ruleFilter || "").trim().toLowerCase();
      for (const el of ruleItems) {
        const hay = (el.dataset.softaliasSearch || "").toLowerCase();
        const show = !q || hay.includes(q);
        el.style.display = show ? "" : "none";
      }
    };

    new Setting(filterInputWrap)
      .setName("Search rules")
      .setDesc("Filter by folder prefix or namespace slug.")
      .addText((t) => {
        t.setPlaceholder("Type to filter…");
        t.setValue(this.ruleFilter);
        t.onChange((v) => {
          this.ruleFilter = v;
          applyRuleFilter();
        });
      });

    const acc = scope.body.createEl("div", { cls: "softalias-accordion" });

    if (this.plugin.settings.folderRules.length === 0) {
      const empty = acc.createEl("div", { cls: "softalias-acc-item" });
      const hdr = empty.createEl("div", { cls: "softalias-acc-header" });
      hdr.createEl("div", { cls: "softalias-muted", text: "No rules yet." });
    }

    this.plugin.settings.folderRules.forEach((rule, idx) => {
      const getTitle = () => {
        const prefix = (rule.folderPrefix || "").trim() || "(no prefix)";
        const slug = (rule.namespaceSlug || "").trim() || "(no slug)";
        return `${prefix} → ${slug}`;
      };
      const getSubtitle = () => `Template: ${rule.templateEnabled ? "On" : "Off"}`;

      const { actions, body, item, titleEl, subEl } = this.makeRuleAccordionItem(
        acc,
        getTitle(),
        getSubtitle(),
        idx === 0 && !this.ruleFilter.trim()
      );

      // search text for live filter
      item.dataset.softaliasSearch = `${rule.folderPrefix || ""} ${rule.namespaceSlug || ""}`;
      ruleItems.push(item);

      // Header icon actions
      this.iconButton(actions, "wand-2", "Normalize all files under this prefix", async () => {
        const p = normalizePrefix(this.plugin.settings.folderRules[idx].folderPrefix);
        const s = this.plugin.settings.folderRules[idx].namespaceSlug.trim();
        if (!p || !s) {
          new Notice("Rule is incomplete.");
          return;
        }
        const n = await this.plugin.normalizeAllFilesUnderPrefix(p);
        new Notice(`Normalized ${n} files under ${p}`);
      });

      this.iconButton(actions, "trash-2", "Remove rule", async () => {
        this.plugin.settings.folderRules.splice(idx, 1);
        await this.plugin.saveSettings();
        this.display(); // ok to re-render on destructive actions
      });

      // Body fields
      const grid = body.createEl("div", { cls: "softalias-grid" });

      new Setting(grid)
        .setName("Folder prefix")
        .setDesc('Example: "index/projects/"')
        .addText((t) => {
          t.setPlaceholder("index/projects/");
          t.setValue(rule.folderPrefix || "");
          
          // ✅ Folder picker suggestions (vault folders)
          new FolderPrefixSuggest(this.app, t.inputEl);

          t.onChange(async (val) => {
            this.plugin.settings.folderRules[idx].folderPrefix = val;
            await this.plugin.saveSettings();

            // Update header text without re-render (mobile keyboard safe)
            titleEl.textContent = getTitle();
            item.dataset.softaliasSearch = `${this.plugin.settings.folderRules[idx].folderPrefix || ""} ${this.plugin.settings.folderRules[idx].namespaceSlug || ""}`;
            applyRuleFilter();
          });
        });

      new Setting(grid)
        .setName("Namespace slug")
        .setDesc('Example: "projects"')
        .addText((t) => {
          t.setPlaceholder("projects");
          t.setValue(rule.namespaceSlug || "");
          t.onChange(async (val) => {
            this.plugin.settings.folderRules[idx].namespaceSlug = val.trim();
            await this.plugin.saveSettings();

            titleEl.textContent = getTitle();
            item.dataset.softaliasSearch = `${this.plugin.settings.folderRules[idx].folderPrefix || ""} ${this.plugin.settings.folderRules[idx].namespaceSlug || ""}`;
            applyRuleFilter();
          });
        });

      new Setting(body)
        .setName("Template on create")
        .setDesc("Automatically apply this YAML to new notes in this folder prefix.")
        .addToggle((tg) => {
          tg.setValue(!!rule.templateEnabled);
          tg.onChange(async (v) => {
            this.plugin.settings.folderRules[idx].templateEnabled = v;
            await this.plugin.saveSettings();

            // update subtitle without re-render
            subEl.textContent = getSubtitle();
          });
        });

      const label = body.createEl("div", {
        text: "Template YAML (no ---). Use alias keys (priority/status/owner).",
        cls: "softalias-muted",
      });
      label.style.marginTop = "8px";
      label.style.marginBottom = "6px";

      const ta = body.createEl("textarea", { cls: "softalias-textarea" });
      ta.placeholder = `priority:
status: draft
owner:
`;
      ta.value = rule.templateYaml || "";
      ta.oninput = async () => {
        this.plugin.settings.folderRules[idx].templateYaml = ta.value;
        await this.plugin.saveSettings();
      };
    });

    applyRuleFilter();

    new Setting(scope.body).addButton((btn) => {
      btn.setButtonText("Add rule");
      btn.onClick(async () => {
        this.plugin.settings.folderRules.push({
          folderPrefix: "",
          namespaceSlug: "",
          templateEnabled: false,
          templateYaml: "",
        });
        await this.plugin.saveSettings();
        this.display();
      });
    });

    /** -------- Section: Managed Keys -------- */
    const keysSec = this.makeSection(
      wrap,
      "Managed Keys",
      "Choose which alias keys are managed and normalized.",
      false
    );

    new Setting(keysSec.body)
      .setName("Managed Alias Keys")
      .setDesc("Comma-separated list. Example: priority,status,owner")
      .addText((t) => {
        t.setValue(this.plugin.settings.managedAliasKeys);
        t.onChange(async (value) => {
          this.plugin.settings.managedAliasKeys = value;
          await this.plugin.saveSettings();
          this.plugin.refreshSuggestObserver(); // update live filter logic
        });
      });

    new Setting(keysSec.body)
      .setName("Remove plain alias keys on sync")
      .setDesc("If enabled, keys like 'priority' are removed after being moved to storage keys.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.removePlainAliasKeysOnSync);
        tg.onChange(async (value) => {
          this.plugin.settings.removePlainAliasKeysOnSync = value;
          await this.plugin.saveSettings();
        });
      });

    /** -------- Section: Storage Format -------- */
    const storageSec = this.makeSection(
      wrap,
      "Storage Key Format",
      "Controls how namespaced storage keys are generated.",
      false
    );

    const updateStoragePreview = (previewEl: HTMLElement) => {
      const exampleSlug =
        this.plugin.settings.folderRules.find((r) => (r.namespaceSlug || "").trim())?.namespaceSlug.trim() ||
        "projects";
      const exampleAlias = parseManagedKeys(this.plugin.settings.managedAliasKeys)[0] || "priority";
      const exampleStorage = this.plugin.makeStorageKey(exampleSlug, exampleAlias);
      previewEl.textContent = `Example storage key: ${exampleStorage}`;
    };

    const preview = storageSec.body.createEl("div", { text: "" });
    preview.style.opacity = "0.85";
    preview.style.marginTop = "6px";
    updateStoragePreview(preview);

    new Setting(storageSec.body)
      .setName("Storage key prefix")
      .setDesc('Set to empty "" if you want keys like "index__priority".')
      .addText((t) => {
        t.setValue(this.plugin.settings.storagePrefix);
        t.onChange(async (value) => {
          this.plugin.settings.storagePrefix = value ?? "";
          await this.plugin.saveSettings();
          this.plugin.refreshSuggestObserver();
          updateStoragePreview(preview); // no re-render (mobile keyboard safe)
        });
      });

    new Setting(storageSec.body)
      .setName("Storage key separator")
      .setDesc('Separator between slug and alias. Default "__".')
      .addText((t) => {
        t.setValue(this.plugin.settings.storageSeparator);
        t.onChange(async (value) => {
          this.plugin.settings.storageSeparator = (value || "__").trim() || "__";
          await this.plugin.saveSettings();
          this.plugin.refreshSuggestObserver();
          updateStoragePreview(preview);
        });
      });

    /** -------- Section: UX Improvements -------- */
    const uxSec = this.makeSection(
      wrap,
      "UX Improvements",
      "Reduce noise in property-name suggestions, keep workflows unchanged.",
      false
    );

    new Setting(uxSec.body)
      .setName("Hide storage keys in property-name suggestions")
      .setDesc("Hides keys like index__priority / ba__index__priority / X__priority from the dropdown.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.hideStorageKeysInPropertyNameSuggest);
        tg.onChange(async (value) => {
          this.plugin.settings.hideStorageKeysInPropertyNameSuggest = value;
          await this.plugin.saveSettings();
          this.plugin.refreshSuggestObserver();
        });
      });

    new Setting(uxSec.body)
      .setName("Enable command: Add managed property")
      .setDesc("Adds a command to add properties without relying on a noisy dropdown.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.enableQuickAddManagedProperty);
        tg.onChange(async (value) => {
          this.plugin.settings.enableQuickAddManagedProperty = value;
          await this.plugin.saveSettings();
        });
      });

    /** -------- Section: Templates -------- */
    const tmplSec = this.makeSection(
      wrap,
      "Templates (like Templater)",
      "Apply per-folder YAML defaults automatically on note creation.",
      false
    );

    new Setting(tmplSec.body)
      .setName("Enable auto-template on note create")
      .setDesc("When a new note is created inside a matching folder rule, apply that rule's template YAML.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.enableAutoTemplateOnCreate);
        tg.onChange(async (value) => {
          this.plugin.settings.enableAutoTemplateOnCreate = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(tmplSec.body)
      .setName("Apply template only if note has no frontmatter")
      .setDesc("If enabled, template only applies when the file starts without YAML frontmatter.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.applyTemplateOnlyIfNoFrontmatter);
        tg.onChange(async (value) => {
          this.plugin.settings.applyTemplateOnlyIfNoFrontmatter = value;
          await this.plugin.saveSettings();
        });
      });

    /** -------- Section: Restore -------- */
    const restoreSec = this.makeSection(
      wrap,
      "Restore",
      "Bring aliases back; optionally remove storage keys (full revert).",
      false
    );

    new Setting(restoreSec.body)
      .setName("Delete storage keys on restore (full revert)")
      .setDesc("If enabled, restoring aliases also removes storage keys.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.deleteStorageKeysOnRestore);
        tg.onChange(async (value) => {
          this.plugin.settings.deleteStorageKeysOnRestore = value;
          await this.plugin.saveSettings();
        });
      });

    /** -------- Section: Automation -------- */
    const autoSec = this.makeSection(
      wrap,
      "Automation",
      "Controls background sync behavior.",
      false
    );

    new Setting(autoSec.body)
      .setName("Debounce delay (ms)")
      .setDesc("Delay before syncing after file events.")
      .addText((t) => {
        t.setValue(String(this.plugin.settings.debounceMs));
        t.onChange(async (value) => {
          const n = Number(value);
          this.plugin.settings.debounceMs = Number.isFinite(n) && n >= 0 ? n : 300;
          await this.plugin.saveSettings();
        });
      });

    new Setting(autoSec.body)
      .setName("Debug logs")
      .setDesc("Enable debug logs in the console.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.debugLogs);
        tg.onChange(async (value) => {
          this.plugin.settings.debugLogs = value;
          await this.plugin.saveSettings();
        });
      });

    /** -------- Section: Actions -------- */
    const actionsSec = this.makeSection(
      wrap,
      "Actions",
      "Manual normalize/restore + inspector.",
      false
    );

    const btnRow = actionsSec.body.createEl("div", { cls: "softalias-btn-row" });

    const mk = (label: string, onClick: () => void) => {
      const b = btnRow.createEl("button", { text: label });
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      };
    };

    mk("Normalize active file", async () => {
      const file = this.plugin.getActiveMarkdownFile();
      if (!file) return;
      await this.plugin.normalizeFileNow(file, "manual");
      new Notice("Normalized active file");
    });

    mk("Restore (active file)", async () => {
      const file = this.plugin.getActiveMarkdownFile();
      if (!file) return;
      await this.plugin.restoreAliasesForFile(file);
      new Notice("Restored aliases for active file");
    });

    mk("Restore (all scoped)", async () => {
      const n = await this.plugin.restoreAliasesForAllScopedFiles();
      new Notice(`Restored aliases for ${n} files`);
    });

    mk("Inspector", () => new AliasInspectorModal(this.app, this.plugin).open());

    const footer = actionsSec.body.createEl("div", { cls: "softalias-muted" });
    footer.style.marginTop = "10px";
    footer.textContent = `Rules: ${this.plugin.settings.folderRules.length}`;
  }
}

/** ---------- Main Plugin ---------- */

export default class SoftAliasNamespacedProperties extends Plugin {
  settings: SoftAliasSettings = { ...DEFAULT_SETTINGS };

  private pendingTimers = new Map<string, number>();
  private inFlight = new Set<string>();

  // Suggest filtering (robust + live)
  private suggestObserver: MutationObserver | null = null;
  private suggestCleanup: (() => void) | null = null;

  async onload() {
    await this.loadSettings();
    this.migrateLegacyRulesIfNeeded();

    this.log("[SoftAlias] Plugin loaded");

    this.addSettingTab(new SoftAliasSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: "soft-alias-show-inspector",
      name: "Show Alias Inspector",
      callback: () => new AliasInspectorModal(this.app, this).open(),
    });

    this.addCommand({
      id: "soft-alias-add-managed-property",
      name: "Add managed property",
      callback: async () => {
        if (!this.settings.enableQuickAddManagedProperty) {
          new Notice("Command disabled in settings.");
          return;
        }
        const file = this.getActiveMarkdownFile();
        if (!file) {
          new Notice("No active markdown file.");
          return;
        }
        const slug = this.getNamespaceSlugForFile(file);
        if (!slug) {
          new Notice("This file is not in any configured rule (no namespace).");
          return;
        }

        new ManagedPropertyPickerModal(this.app, this, async (aliasKey) => {
          await this.addManagedPropertyToFile(file, aliasKey);
          new Notice(`Added property: ${aliasKey}`);
        }).open();
      },
    });

    // Events: active file open
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const file = this.getFileFromLeaf(leaf);
        if (file) this.scheduleNormalize(file, "open");
      })
    );

    // Events: metadata updated
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") this.scheduleNormalize(file, "metadata-changed");
      })
    );

    // Events: file modified
    this.registerEvent(
      this.app.vault.on("modify", (af: TAbstractFile) => {
        if (af instanceof TFile && af.extension === "md") this.scheduleNormalize(af, "modify");
      })
    );

    // Events: file created -> template
    this.registerEvent(
      this.app.vault.on("create", (af: TAbstractFile) => {
        if (!this.settings.enableAutoTemplateOnCreate) return;
        if (!(af instanceof TFile) || af.extension !== "md") return;

        window.setTimeout(() => {
          this.applyTemplateToNewFile(af).catch((e) => this.log(`[SoftAlias] template error: ${e}`));
        }, 200);
      })
    );

    // Start suggest observer (live filter)
    this.refreshSuggestObserver();

    // Startup normalize
    const active = this.getActiveMarkdownFile();
    if (active) this.scheduleNormalize(active, "open");
  }

  onunload() {
    this.log("[SoftAlias] Plugin unloaded");
    for (const id of this.pendingTimers.values()) window.clearTimeout(id);
    this.pendingTimers.clear();
    this.inFlight.clear();
    this.stopSuggestObserver();
  }

  /** ---------- Settings ---------- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private migrateLegacyRulesIfNeeded() {
    if (this.settings.folderRules && this.settings.folderRules.length > 0) return;
    const legacy = (this.settings.folderRulesJson || "").trim();
    if (!legacy) return;

    const { rules } = safeJsonParseLegacyRules(legacy);
    if (rules.length > 0) {
      this.settings.folderRules = rules;
      this.log(`[SoftAlias] Migrated ${rules.length} legacy JSON rules into list rules.`);
      this.saveSettings().catch(() => {});
    }
  }

  /** ---------- Key logic ---------- */

  getManagedAliasKeys(): string[] {
    return parseManagedKeys(this.settings.managedAliasKeys);
  }

  makeStorageKey(slug: string, aliasKey: string): string {
    const prefix = (this.settings.storagePrefix ?? "").trim();
    const sep = (this.settings.storageSeparator || "__").trim() || "__";
    return `${prefix}${slug}${sep}${aliasKey}`;
  }

  /** ---------- File / scope helpers ---------- */

  getActiveMarkdownFile(): TFile | null {
    const leaf = this.app.workspace.activeLeaf;
    return this.getFileFromLeaf(leaf);
  }

  private getFileFromLeaf(leaf: WorkspaceLeaf | null): TFile | null {
    if (!leaf) return null;
    const view = leaf.view;
    if (view instanceof MarkdownView) return view.file ?? null;
    return null;
  }

  getNamespaceSlugForFile(file: TFile): string | null {
    const path = file.path.replace(/\\/g, "/");
    for (const rule of this.settings.folderRules) {
      const prefix = normalizePrefix(rule.folderPrefix);
      const slug = (rule.namespaceSlug || "").trim();
      if (!prefix || !slug) continue;
      if (path.startsWith(prefix)) return slug;
    }
    return null;
  }

  private getRuleForFile(file: TFile): FolderRule | null {
    const path = file.path.replace(/\\/g, "/");
    for (const rule of this.settings.folderRules) {
      const prefix = normalizePrefix(rule.folderPrefix);
      const slug = (rule.namespaceSlug || "").trim();
      if (!prefix || !slug) continue;
      if (path.startsWith(prefix)) return rule;
    }
    return null;
  }

  /** ---------- Background normalize ---------- */

  private scheduleNormalize(file: TFile, reason: SyncReason) {
    const slug = this.getNamespaceSlugForFile(file);
    if (!slug) return;

    const key = file.path;
    const ms = Math.max(0, this.settings.debounceMs);

    const existing = this.pendingTimers.get(key);
    if (existing) window.clearTimeout(existing);

    const id = window.setTimeout(() => {
      this.pendingTimers.delete(key);
      this.normalizeFileNow(file, reason).catch((e) => this.log(`[SoftAlias] normalize error: ${e}`));
    }, ms);

    this.pendingTimers.set(key, id);
    this.log(`[SoftAlias] scheduled sync (${reason}) for: ${file.path} in ${ms}ms`);
  }

  async normalizeFileNow(file: TFile, reason: SyncReason) {
    const slug = this.getNamespaceSlugForFile(file);
    if (!slug) return;

    const fileKey = file.path;
    if (this.inFlight.has(fileKey)) return;

    const managed = this.getManagedAliasKeys();
    if (managed.length === 0) return;

    const cache = this.app.metadataCache.getFileCache(file);
    const fmPreview: Record<string, any> = (cache?.frontmatter as any) ?? {};
    if (!this.computeNeedsNormalization(fmPreview, slug, managed)) {
      this.log(`[SoftAlias] no changes needed (${reason}) for: ${file.path}`);
      return;
    }

    this.inFlight.add(fileKey);
    try {
      this.log(`[SoftAlias] normalize start (${reason}) slug=${slug} file=${file.path}`);

      await this.app.fileManager.processFrontMatter(file, (fm) => {
        for (const aliasKey of managed) {
          const storageKey = this.makeStorageKey(slug, aliasKey);

          const hasAlias = Object.prototype.hasOwnProperty.call(fm, aliasKey);
          const hasStorage = Object.prototype.hasOwnProperty.call(fm, storageKey);

          if (hasStorage) {
            if (this.settings.removePlainAliasKeysOnSync && hasAlias) {
              delete (fm as any)[aliasKey];
              this.log(`[SoftAlias] removed plain alias key: ${aliasKey}`);
            }
            continue;
          }

          if (hasAlias) {
            (fm as any)[storageKey] = (fm as any)[aliasKey];
            this.log(`[SoftAlias] moved ${aliasKey} -> ${storageKey}`);

            if (this.settings.removePlainAliasKeysOnSync) {
              delete (fm as any)[aliasKey];
              this.log(`[SoftAlias] removed plain alias key: ${aliasKey}`);
            }
          }
        }
      });

      this.log(`[SoftAlias] normalize done (${reason}) for: ${file.path}`);
    } finally {
      this.inFlight.delete(fileKey);
    }
  }

  private computeNeedsNormalization(fm: Record<string, any>, slug: string, managed: string[]): boolean {
    for (const aliasKey of managed) {
      const storageKey = this.makeStorageKey(slug, aliasKey);
      const hasAlias = Object.prototype.hasOwnProperty.call(fm, aliasKey);
      const hasStorage = Object.prototype.hasOwnProperty.call(fm, storageKey);

      if (!hasStorage && hasAlias) return true;
      if (hasStorage && hasAlias && this.settings.removePlainAliasKeysOnSync) return true;
    }
    return false;
  }

  async normalizeAllFilesUnderPrefix(folderPrefix: string): Promise<number> {
    const prefix = normalizePrefix(folderPrefix);
    if (!prefix) return 0;

    const mdFiles = this.app.vault.getMarkdownFiles();
    let count = 0;

    for (const f of mdFiles) {
      const p = f.path.replace(/\\/g, "/");
      if (!p.startsWith(prefix)) continue;
      await this.normalizeFileNow(f, "manual");
      count++;
    }
    return count;
  }

  /** ---------- Add managed property (command) ---------- */
  async addManagedPropertyToFile(file: TFile, aliasKey: string) {
    const slug = this.getNamespaceSlugForFile(file);
    if (!slug) return;

    const fileKey = file.path;
    if (this.inFlight.has(fileKey)) return;

    this.inFlight.add(fileKey);
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (!Object.prototype.hasOwnProperty.call(fm, aliasKey)) {
          (fm as any)[aliasKey] = null;
        }
      });

      this.scheduleNormalize(file, "manual");
    } finally {
      this.inFlight.delete(fileKey);
    }
  }

  /** ---------- Restore ---------- */

  async restoreAliasesForFile(file: TFile) {
    const rule = this.getRuleForFile(file);
    if (!rule) return;

    const slug = rule.namespaceSlug.trim();
    const managed = this.getManagedAliasKeys();
    if (managed.length === 0) return;

    const fileKey = file.path;
    if (this.inFlight.has(fileKey)) return;

    this.inFlight.add(fileKey);
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        for (const aliasKey of managed) {
          const storageKey = this.makeStorageKey(slug, aliasKey);
          if (!Object.prototype.hasOwnProperty.call(fm, storageKey)) continue;

          (fm as any)[aliasKey] = (fm as any)[storageKey];
          this.log(`[SoftAlias] restored ${aliasKey} <- ${storageKey}`);

          if (this.settings.deleteStorageKeysOnRestore) {
            delete (fm as any)[storageKey];
            this.log(`[SoftAlias] deleted storage key on restore: ${storageKey}`);
          }
        }
      });
    } finally {
      this.inFlight.delete(fileKey);
    }
  }

  async restoreAliasesForAllScopedFiles(): Promise<number> {
    const mdFiles = this.app.vault.getMarkdownFiles();
    let count = 0;
    for (const f of mdFiles) {
      const rule = this.getRuleForFile(f);
      if (!rule) continue;
      await this.restoreAliasesForFile(f);
      count++;
    }
    return count;
  }

  /** ---------- Templates ---------- */

  private async applyTemplateToNewFile(file: TFile) {
    const rule = this.getRuleForFile(file);
    if (!rule) return;
    if (!rule.templateEnabled) return;

    const yamlText = (rule.templateYaml || "").trim();
    if (!yamlText) return;

    if (this.settings.applyTemplateOnlyIfNoFrontmatter) {
      const content = await this.app.vault.read(file);
      if (content.startsWith("---")) {
        this.log(`[SoftAlias][Template] Skip: already has frontmatter: ${file.path}`);
        return;
      }
    }

    let obj: any;
    try {
      obj = parseYaml(yamlText);
    } catch (e) {
      new Notice("Template YAML is invalid. Check settings.");
      this.log(`[SoftAlias][Template] parseYaml error: ${e}`);
      return;
    }
    if (!obj || typeof obj !== "object") {
      new Notice("Template YAML must produce an object (key: value).");
      return;
    }

    const slug = rule.namespaceSlug.trim();
    const managed = this.getManagedAliasKeys();
    const managedSet = new Set(managed);

    const fileKey = file.path;
    if (this.inFlight.has(fileKey)) return;

    this.inFlight.add(fileKey);
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        for (const [k, v] of Object.entries(obj)) {
          const aliasKey = String(k).trim();
          if (!aliasKey) continue;

          // safer UX: only managed keys
          if (managedSet.size > 0 && !managedSet.has(aliasKey)) continue;

          const storageKey = this.makeStorageKey(slug, aliasKey);

          if (Object.prototype.hasOwnProperty.call(fm, storageKey)) continue;

          (fm as any)[storageKey] = v;
          this.log(`[SoftAlias][Template] set ${storageKey} for new file ${file.path}`);

          if (!this.settings.removePlainAliasKeysOnSync) {
            if (!Object.prototype.hasOwnProperty.call(fm, aliasKey)) (fm as any)[aliasKey] = v;
          }
        }
      });

      this.scheduleNormalize(file, "manual");
    } finally {
      this.inFlight.delete(fileKey);
    }
  }
  /** ---------- Suggest filtering (ROBUST + LIVE / Notes-only via focus) ---------- */

  refreshSuggestObserver() {
    this.stopSuggestObserver();
    if (!this.settings.hideStorageKeysInPropertyNameSuggest) return;

    let raf = 0;

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        this.filterAllSuggestContainers();
      });
    };

    this.suggestObserver = new MutationObserver(() => schedule());
    this.suggestObserver.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("keydown", schedule, true);
    window.addEventListener("pointerdown", schedule, true);
    window.addEventListener("focusin", schedule, true);

    this.suggestCleanup = () => {
      window.removeEventListener("keydown", schedule, true);
      window.removeEventListener("pointerdown", schedule, true);
      window.removeEventListener("focusin", schedule, true);
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    schedule();
    this.log("[SoftAlias] Suggest observer enabled (focus-gated)");
  }

  private stopSuggestObserver() {
    if (this.suggestObserver) {
      this.suggestObserver.disconnect();
      this.suggestObserver = null;
    }
    if (this.suggestCleanup) {
      this.suggestCleanup();
      this.suggestCleanup = null;
    }
    this.log("[SoftAlias] Suggest observer disabled");
  }

  private filterAllSuggestContainers() {
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".suggestion-container, .suggestion, .prompt-results, .menu"
      )
    );
    for (const c of containers) this.filterSuggestContainer(c);
  }

  private filterSuggestContainer(container: HTMLElement) {
    const managed = this.getManagedAliasKeys();
    if (managed.length === 0) return;

    const active = document.activeElement as HTMLElement | null;
    if (!active) return;

    // If focus is inside Bases => never filter
    const focusInBases =
      !!active.closest(".workspace-leaf[data-type='bases']") ||
      !!active.closest(".bases-view") ||
      !!active.closest(".bases-table") ||
      !!active.closest("[class*='bases']");

    if (focusInBases) return;

    // Only filter inside note Properties UI
    const focusInNoteProperties =
      !!active.closest(".metadata-properties") ||
      !!active.closest(".metadata-container") ||
      !!active.closest(".metadata-property") ||
      !!active.closest(".metadata-property-key") ||
      !!active.closest("[class*='metadata']");

    if (!focusInNoteProperties) return;

    const sep = (this.settings.storageSeparator || "__").trim() || "__";
    const prefix = (this.settings.storagePrefix ?? "").trim();

    const items = Array.from(
      container.querySelectorAll<HTMLElement>(".suggestion-item, [role='option']")
    );
    if (items.length === 0) return;

    for (const it of items) {
      const raw =
        (it.querySelector(".suggestion-content")?.textContent ||
          it.textContent ||
          "").replace(/\s+/g, " ").trim();

      if (!raw) continue;

      // Keep exact alias keys visible
      if (managed.includes(raw)) {
        it.style.display = "";
        it.removeAttribute("data-softalias-hidden");
        continue;
      }

      // Hide anything ending with `${sep}${alias}`
      const endsWithAlias = managed.some((alias) => raw.endsWith(`${sep}${alias}`));
      if (endsWithAlias) {
        it.style.display = "none";
        it.setAttribute("data-softalias-hidden", "1");
        continue;
      }

      // Hide by explicit prefix
      if (prefix && raw.startsWith(prefix)) {
        it.style.display = "none";
        it.setAttribute("data-softalias-hidden", "1");
        continue;
      }

      // Hide classic ba__
      if (raw.startsWith("ba__")) {
        it.style.display = "none";
        it.setAttribute("data-softalias-hidden", "1");
        continue;
      }

      it.style.display = "";
      it.removeAttribute("data-softalias-hidden");
    }
  }

/** ---------- Logging ---------- */ 
private log(msg: string) { if (this.settings.debugLogs) console.log(msg); } }
