import * as vscode from "vscode";
import { window, workspace, QuickPickItem } from "vscode";
import { FILE_NAME, OVERRIDE_OPTIONS, PLACEHOLDERS } from "./config";

const COMMON_SUBDIRS = [
    { label: "src/", description: "Source code directory" },
    { label: "client/", description: "Client code directory" },
    { label: "server/", description: "Server code directory" },
    { label: "api/", description: "API directory" },
    { label: "$(edit) Custom path...", description: "Enter a custom subdirectory" },
];

export function getFolderOption(folders) {
    const options = folders.map(folder => folder.name);

    return window.showQuickPick(options, {
        placeHolder: PLACEHOLDERS.location,
    });
}

export function getOverrideOption() {
    return window
        .showQuickPick(OVERRIDE_OPTIONS, {
            placeHolder: PLACEHOLDERS.override,
        })
        .then(option => {
            if (option === undefined) {
                return undefined;
            }

            return option === OVERRIDE_OPTIONS[0] ? true : false;
        });
}

export async function getSubdirectoryOption(): Promise<string | undefined> {
    const selected = await window.showQuickPick(COMMON_SUBDIRS, {
        placeHolder: PLACEHOLDERS.subdirectory,
        matchOnDescription: true,
    });

    if (selected === undefined) {
        return undefined;
    }

    // If user selected custom path, open input box
    if (selected.label.includes("$(edit)")) {
        return await window.showInputBox({
            prompt: "Enter subdirectory path (e.g., api/v2, src, config)",
            placeHolder: "subdirectory",
            validateInput: (input) => {
                if (!input) {
                    return "Subdirectory path cannot be empty";
                }
                if (input.startsWith("/") || input.startsWith("\\")) {
                    return "Subdirectory path cannot be absolute";
                }
                if (input.includes("..")) {
                    return "Subdirectory path cannot escape to parent directories";
                }
                return null;
            },
        });
    }

    // Remove trailing slash for consistency
    return selected.label.replace(/\/$/, "");
}

export function getItemsOption(items: QuickPickItem[]) {
    return window
        .showQuickPick(items, {
            canPickMany: true,
            placeHolder: PLACEHOLDERS.selection_hint,
        })
        .then(selected => {
            if (selected === undefined || selected.length === 0) {
                return undefined;
            }

            return selected.map(item => item.label);
        });
}

export function openFile(filePath: string) {
    vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
}

export function openUntitledFile(content: string) {
    workspace.openTextDocument({ content }).then(doc => {
        window.showTextDocument(doc);
    });
}
