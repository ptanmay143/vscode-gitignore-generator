import * as path from "path";
import * as fs from "fs";
import { window, workspace } from "vscode";
import { getConfig, FILE_NAME, MESSAGES } from "./modules/config";
import {
    getFolderOption,
    getItemsOption,
    getOverrideOption,
    getSubdirectoryOption,
    openFile,
    openUntitledFile,
} from "./modules/ui";
import { fileExists, hasFolder, writeFile } from "./modules/filesystem";
import { generateFile, getList, fetchWithFallback } from "./modules/helpers";

export default class SubdirectoryGenerator {
    private folders = workspace.workspaceFolders;
    private filePath: string | null = null;
    private override: boolean = true;
    private subdirectory: string | null = null;
    private selected: string[];

    public async init() {
        this.filePath = await this.getFilePath();

        if (this.filePath) {
            this.override = await this.getOverrideOption();
        }

        this.selected = await this.getSelectedOptions();
        this.generate();
    }

    private async get(fn, ...args) {
        const result = await fn.apply(this, args);

        if (result === undefined) {
            this.abort();
        }

        return result;
    }

    private async getFilePath() {
        if (!hasFolder(this.folders)) {
            return null;
        }

        const folderName =
            this.folders.length > 1
                ? await this.get(getFolderOption, this.folders)
                : this.folders[0].name;

        const folderPath = this.folders.find(
            folder => folder.name === folderName
        ).uri.fsPath;

        // Get subdirectory from user
        this.subdirectory = await this.get(getSubdirectoryOption);

        // Normalize subdirectory path
        const normalizedSubdir = this.subdirectory ? this.subdirectory.replace(/\\/g, "/").replace(/\/$/, "") : this.subdirectory;

        // Create full path with subdirectory
        return normalizedSubdir
            ? path.join(folderPath, normalizedSubdir, FILE_NAME)
            : path.join(folderPath, FILE_NAME);
    }

    private async getOverrideOption() {
        // Check if file exists in the subdirectory
        const fileExistsInSubdir = fileExists(this.filePath);

        const config = getConfig();

        if (config.AUTO_SELECT_MODE) {
            const override = !fileExistsInSubdir;
            if (config.ENABLE_DEBUG_LOGGING) {
                console.log(
                    `[GitIgnore Generator] Auto-select mode: file exists=${fileExistsInSubdir}, override=${override}`,
                );
            }
            return override;
        }

        // Manual mode: always prompt user
        return fileExistsInSubdir ? await this.get(getOverrideOption) : true;
    }

    private async getSelectedOptions() {
        let message = window.setStatusBarMessage(MESSAGES.fetching);

        const list = await getList(this.filePath, !this.override);

        message.dispose();

        if (list === null) {
            return window.showErrorMessage(MESSAGES.network_error);
        }

        return await this.get(getItemsOption, list);
    }

    private async generate() {
        const message = window.setStatusBarMessage(MESSAGES.generating);
        const config = getConfig();

        // Ensure subdirectory exists
        if (this.filePath) {
            const dirname = path.dirname(this.filePath);
            try {
                if (!fs.existsSync(dirname)) {
                    // Create directories recursively
                    const parts = dirname.split(path.sep);
                    let currentPath = "";
                    for (const part of parts) {
                        currentPath = path.join(currentPath, part);
                        if (currentPath && !fs.existsSync(currentPath)) {
                            fs.mkdirSync(currentPath);
                        }
                    }
                }
            } catch (error) {
                message.dispose();
                return window.showErrorMessage(
                    `Failed to create subdirectory: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        let notificationShown = false;

        // Use new robust failover chain to fetch templates
        const fetchResult = await fetchWithFallback(this.selected);

        // Show notification if fallback occurred and notifications are enabled
        if (fetchResult.fallbackReason && config.SHOW_FALLBACK_NOTIFICATION && !notificationShown) {
            notificationShown = true;
            window.showInformationMessage(
                `${fetchResult.fallbackReason}. Using ${fetchResult.source} for templates.`,
            );
        }

        if (fetchResult.content === null) {
            message.dispose();
            return window.showErrorMessage(MESSAGES.all_sources_failed);
        }

        const output = generateFile(
            this.filePath,
            fetchResult.content,
            this.override,
            this.selected,
            fetchResult.source, // Pass source info to generateFile
            fetchResult.fallbackReason, // Pass fallback reason
        );

        if (this.filePath) {
            const result = writeFile(this.filePath, output);

            if (result === false) {
                message.dispose();
                window.showErrorMessage(MESSAGES.save_error);
                this.abort();
            }

            openFile(this.filePath);
        } else {
            openUntitledFile(output);
        }

        message.dispose();

        window.setStatusBarMessage(
            MESSAGES.generated.replace(
                "[action]",
                this.override ? "created" : "updated"
            ),
            3000
        );
    }

    private abort() {
        throw new Error("Extension action aborted");
    }
}
