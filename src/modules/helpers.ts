import * as os from "os";
import { readFile } from "./filesystem";
import { getData, HttpResponse } from "./http";
import { getConfig, PreferredSource, SOURCE_PRIORITY_CHAIN } from "./config";

export interface FetchResult {
    content: string | null;
    source: string;
    failedTemplates: string[];
    fallbackReason?: string;
    attemptDetails?: Record<string, any>;
}

export function hitAntiDdos(value: string | null) {
    if (value === null) {
        return false;
    }

    return (/^<!DOCTYPE.*>/gi).test(value.trim());
}

/**
 * Fetches templates from a specific source (GitHub, Primary API, or Fallback API)
 * Returns null if all attempts fail for that source
 */
async function fetchFromSource(
    source: PreferredSource,
    templates: string[],
): Promise<FetchResult | null> {
    const config = getConfig();
    const debugLogging = config.ENABLE_DEBUG_LOGGING;

    if (source === PreferredSource.GitHub) {
        // GitHub: fetch individual templates from multiple locations
        // Sort templates alphabetically for consistent output
        const sortedTemplates = [...templates].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const contents: string[] = [];
        const failedTemplates: string[] = [];

        for (const template of sortedTemplates) {
            const locations = [
                `${config.GITHUB_GITIGNORE_URL}/${template}.gitignore`,
                `${config.GITHUB_GITIGNORE_URL}/Global/${template}.gitignore`,
                `${config.GITHUB_GITIGNORE_URL}/community/${template}.gitignore`,
            ];

            let found = false;
            for (const url of locations) {
                const response = await getData(url);
                if (response.success && response.content) {
                    // Clean each template individually before combining
                    const cleaned = cleanSingleTemplate(response.content);
                    if (cleaned) {
                        // Add individual template header with consistent formatting
                        const templateHeader = `# ${template.toUpperCase()}\n# ${"-".repeat(template.length)}`;
                        contents.push(`${templateHeader}\n\n${cleaned}`);
                    }
                    found = true;
                    break;
                }
            }

            if (!found) {
                failedTemplates.push(template);
            }
        }

        if (contents.length === 0) {
            return null;
        }

        return {
            content: normalizeCombinedTemplates(contents.join("\n\n")),
            source: "GitHub",
            failedTemplates,
        };
    } else {
        // API sources (Primary or Fallback)
        // Sort templates alphabetically for consistent output
        const sortedTemplates = [...templates].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const sourceUrl = source === PreferredSource.PrimaryApi ? config.API_URL : config.ALTERNATIVE_API_URL;
        const sourceName = source === PreferredSource.PrimaryApi ? "Primary API" : "Fallback API";
        const url = `${sourceUrl}/${sortedTemplates.join(",")}`;

        const response = await getData(url);

        if (!response.success || !response.content) {
            return null;
        }

        // Clean API response before returning
        const cleaned = cleanSingleTemplate(response.content);

        return {
            content: normalizeCombinedTemplates(cleaned),
            source: sourceName,
            failedTemplates: [],
        };
    }
}

/**
 * Main function: Fetches templates with 3-stage failover chain
 * Priority: Preferred Source → GitHub → Primary API → Fallback API
 */
export async function fetchWithFallback(templates: string[]): Promise<FetchResult> {
    const config = getConfig();
    const debugLogging = config.ENABLE_DEBUG_LOGGING;
    const preferredSource = config.PREFERRED_SOURCE as PreferredSource;

    // Build the fallback chain based on preferred source
    const fallbackChain: PreferredSource[] = [preferredSource];

    // Add other sources to the chain
    SOURCE_PRIORITY_CHAIN.forEach(source => {
        if (source !== preferredSource && fallbackChain.indexOf(source) === -1) {
            fallbackChain.push(source);
        }
    });

    if (debugLogging) {
        console.log(
            `[GitIgnore Generator] Starting fetch chain: ${fallbackChain.join(" → ")} for templates: ${templates.join(", ")}`,
        );
    }

    let lastError: string | undefined;
    let attemptDetails: Record<string, any> = {};

    for (let i = 0; i < fallbackChain.length; i++) {
        const source = fallbackChain[i];
        const isPreferred = source === preferredSource;

        if (debugLogging) {
            console.log(`[GitIgnore Generator] Attempting source ${i + 1}/${fallbackChain.length}: ${source}${isPreferred ? " (preferred)" : ""}`);
        }

        const result = await fetchFromSource(source, templates);

        if (result && result.content) {
            const fallbackReason = !isPreferred ? `Switched from ${preferredSource} to ${result.source}` : undefined;

            if (debugLogging && fallbackReason) {
                console.log(`[GitIgnore Generator] ${fallbackReason}`);
            }

            return {
                ...result,
                fallbackReason,
                attemptDetails,
            };
        }
    }

    return {
        content: null,
        source: "None",
        failedTemplates: templates,
        fallbackReason: `All sources failed in chain: ${fallbackChain.join(" → ")}`,
        attemptDetails,
    };
}

export async function getList(path: string | null, keepCurrent: boolean) {
    const config = getConfig();
    const preferredSource = config.PREFERRED_SOURCE;

    // Try to get the list from the preferred source first
    let response = await getData(`${config.API_URL}/list`);

    if (!response.success && preferredSource !== PreferredSource.PrimaryApi) {
        // Try alternative API
        response = await getData(`${config.ALTERNATIVE_API_URL}/list`);
    }

    if (!response.success || !response.content) {
        return null;
    }

    const data = response.content;
    const selectedItems = getSelectedItems(path, keepCurrent);

    const items = data.split(/[,\n\r]+/).map(item => ({
        label: item,
        picked: selectedItems.indexOf(item) !== -1,
    }));

    items.pop();

    items.sort((a, b) => {
        if (a.picked) {
            return -1;
        } else if (b.picked) {
            return 1;
        }

        return 0;
    });

    return items;
}

export function getOs() {
    const systems = {
        darwin: "macos",
        linux: "linux",
        win32: "windows",
    };

    const system = systems[os.platform()];

    return system ? system : null;
}

export function getCurrentItems(filePath: string) {
    const file = readFile(filePath);

    if (file === null) {
        return [];
    }

    // Try new format first: "# Templates:    item1, item2, item3"
    let regex = /^#\s+Templates:\s+(.+?)$/m;
    let result = regex.exec(file);

    if (result && result[1]) {
        const templates = result[1]
            .split(/,\s*/)
            .map(item => item.trim())
            .filter(item => item.length > 0 && item !== "unknown");
        if (templates.length > 0) {
            return templates;
        }
    }

    // Fallback to old format: "# Created by name/email, template1, template2"
    regex = /^#\s+Created\s+by[:\s]+(.*?)(?:\s+\/|$)/m;
    result = regex.exec(file);

    if (result && result[1]) {
        const templates = result[1]
            .split(/,\s*/)
            .map(item => item.trim())
            .filter(item => item.length > 0 && !item.startsWith("http"));
        if (templates.length > 0) {
            return templates;
        }
    }

    return [];
}

export function getUserRules(filePath) {
    const file = readFile(filePath);

    if (file === null) {
        return null;
    }

    // Try new format: "# User-defined rules" section
    let regex = /^# User-defined rules\n([\s\S]*?)(?:\n# ==============|$)/m;
    let result = regex.exec(file);

    if (result && result[1]) {
        const content = result[1].trim();
        // Make sure we got actual rules, not just another comment header
        if (content.length > 0 && !content.startsWith("# ")) {
            return content;
        }
    }

    // Try intermediate format: "# Custom rules" section
    regex = /^# Custom rules[^\n]*\n([\s\S]*?)(?:\n# (?:Templated|Auto-generated)|# ==============|$)/m;
    result = regex.exec(file);

    if (result && result[1]) {
        const content = result[1].trim();
        if (content.length > 0 && !content.startsWith("# ")) {
            return content;
        }
    }

    // Fallback to very old format with old separators
    const oldSeparator = "# ========================================";
    const parts = file.split(oldSeparator);

    if (parts.length >= 2) {
        const content = parts[1].trim();
        if (content.length > 0 && !content.startsWith("# ")) {
            return content;
        }
    }

    return null;
}

export function getSelectedItems(
    filePath: string | null,
    keepCurrent: boolean
) {
    const selected = [];

    if (!keepCurrent) {
        selected.push("visualstudiocode", getOs());
    }

    if (keepCurrent && filePath) {
        selected.push(...getCurrentItems(filePath));
    }

    return selected.filter(item => !!item);
}

export async function fetchGitHubTemplate(template: string): Promise<string | null> {
    const config = getConfig();
    // Try common locations: root, Global/, and community/
    const locations = [
        `${config.GITHUB_GITIGNORE_URL}/${template}.gitignore`,
        `${config.GITHUB_GITIGNORE_URL}/Global/${template}.gitignore`,
        `${config.GITHUB_GITIGNORE_URL}/community/${template}.gitignore`,
    ];

    for (const url of locations) {
        const response = await getData(url);
        if (response.success && response.content && !hitAntiDdos(response.content)) {
            return response.content;
        }
    }

    return null;
}

export async function fetchTemplatesFromGitHub(templates: string[]): Promise<string | null> {
    const contents: string[] = [];
    const failedTemplates: string[] = [];

    for (const template of templates) {
        const content = await fetchGitHubTemplate(template);
        if (content !== null) {
            contents.push(content.trim());
        } else {
            failedTemplates.push(template);
        }
    }

    // If some templates failed, log them but continue with what we got
    if (failedTemplates.length > 0) {
        console.warn(`Failed to fetch templates from GitHub: ${failedTemplates.join(", ")}`);
    }

    // Return combined content or null if nothing was fetched
    return contents.length > 0 ? contents.join("\n\n") : null;
}

/**
 * Cleans a single template by removing API-specific metadata
 */
function cleanSingleTemplate(content: string): string {
    const lines = content.split("\n");
    const cleaned: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comment-only lines
        if (trimmed === "" || trimmed === "#") {
            continue;
        }

        // Remove "Created by" metadata lines
        if (/^#\s*(?:created\s+by|autogenerated\s+by|gen\s+by)/i.test(line)) {
            continue;
        }

        // Remove "Edit at" or "Edit on" lines
        if (/^#\s*(?:edit\s+(?:at|on)|see\s+https?:)/i.test(line)) {
            continue;
        }

        // Remove standalone URL comment lines (just URLs after #)
        if (/^#\s+https?:\/\//i.test(line)) {
            continue;
        }

        // Remove end-of-file markers
        if (/^#\s*(?:end\s+of\s+.*|thanks\s+|source:)/i.test(line)) {
            continue;
        }

        cleaned.push(line);
    }

    // Join and normalize spacing
    let result = cleaned.join("\n").trim();

    // Remove excessive blank lines (more than 2 consecutive newlines)
    result = result.replace(/\n\n\n+/g, "\n\n");

    return result;
}

/**
 * Cleans combined templates by normalizing spacing
 */
function normalizeCombinedTemplates(content: string): string {
    // Remove excessive blank lines
    let result = content.replace(/\n\n\n+/g, "\n\n");

    // Ensure no trailing whitespace on lines
    result = result
        .split("\n")
        .map(line => line.replace(/\s+$/, ""))
        .join("\n");

    // Ensure single trailing newline
    result = result.replace(/\n+$/, "");

    return result;
}

export function generateFile(
    path: string,
    autoGeneratedContent: string,
    override: boolean,
    templates?: string[],
    source: string = "Primary API",
    fallbackReason?: string,
) {
    const config = getConfig();
    // Sort templates alphabetically for consistent display
    const sortedTemplates = templates && templates.length > 0
        ? [...templates].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        : [];
    const templateList = sortedTemplates.length > 0 ? sortedTemplates.join(", ") : "unknown";
    const timestamp = new Date().toISOString();

    // Consistent separators with proper spacing
    const headerSeparator = "# ════════════════════════════════════════════════════════════════";
    const sectionSeparator = "# ────────────────────────────────────────────────────────────────";

    let output = "";

    if (config.INCLUDE_METADATA) {
        // Enhanced header with metadata
        output += `${headerSeparator}\n`;
        output += "#\n";
        output += "#  .gitignore\n";
        output += "#  Generated by: .gitignore Generator (https://bit.ly/vscode-gig)\n";
        output += "#\n";
        output += `${headerSeparator}\n`;
        output += "#\n";
        output += `#  Generated:       ${timestamp}\n`;
        output += `#  Templates:       ${templateList}\n`;
        output += `#  Source:          ${source}${fallbackReason ? ` (${fallbackReason})` : ""}\n`;
        output += "#\n";
    } else {
        // Minimal header
        output += `# ${config.BANNER}\n`;
    }

    if (config.INCLUDE_DOCUMENTATION) {
        output += `#\n${headerSeparator}\n`;
        output += "#  How to Maintain This .gitignore File\n";
        output += `${headerSeparator}\n`;
        output += "#\n";
        output += "#  CUSTOM RULES SECTION\n";
        output += "#    • Add your project-specific rules in the Custom Rules section\n";
        output += "#    • These rules will be preserved when updating the file\n";
        output += "#    • Examples: *.tmp, build/, dist/, coverage/, .env\n";
        output += "#\n";
        output += "#  TEMPLATED RULES SECTION\n";
        output += "#    • Managed automatically by .gitignore Generator\n";
        output += "#    • Do not edit manually - changes will be overwritten on update\n";
        output += "#    • Contains rules from selected templates (see above)\n";
        output += "#\n";
        output += "#  TO UPDATE THIS FILE\n";
        output += "#    1. Run: 'Generate .gitignore File' command\n";
        output += "#    2. Choose 'Update' to preserve your custom rules\n";
        output += "#    3. Choose 'Override' to replace the entire file\n";
        output += "#\n";
        output += "#  REFERENCES\n";
        output += "#    • .gitignore Manual: https://git-scm.com/docs/gitignore\n";
        output += "#    • GitHub Gitignore: https://github.com/github/gitignore\n";
        output += "#\n";
    }

    output += `${headerSeparator}\n`;
    output += "#  CUSTOM RULES\n";
    output += `${headerSeparator}\n`;
    output += "#\n";

    if (!override) {
        // Preserve existing user rules when updating
        const userRules = getUserRules(path);
        if (userRules) {
            output += userRules;
            output += "\n\n";
        }
    }

    output += `#\n${headerSeparator}\n`;
    output += "#  TEMPLATED RULES\n";
    output += `${headerSeparator}\n`;
    output += "#\n";

    // Add templated rules section with proper spacing
    output += autoGeneratedContent;
    output += `\n\n${headerSeparator}\n`;

    return `${output}\n`;
}
